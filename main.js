/* ============================================================================
 * template-derive — 按自定义模板自动衍生文件
 * ----------------------------------------------------------------------------
 * 一句话：一条「规则」描述「哪个文件夹里的哪个段落，要渲染到哪个文件的哪个位置」，
 * 插件监听保存事件，段落里写了东西就生成 / 更新产物文件，没写就不生成。
 *
 * ── 为什么做成规则驱动，而不是把日记逻辑写死在代码里 ──────────────────────
 * 第一版是给日记专用的：文件夹、段落名、三套渲染骨架全写死在常量里，
 * 想换个落点就得改代码。这一版把「源 → 判定 → 产物」抽成数据，日记只是
 * 出厂自带的一组预设规则。规则存在 data.json 里，可以在设置界面改，也能导出分享。
 *
 * ── 一条规则有四个部分 ─────────────────────────────────────────────────
 *   from  源：文件夹 + 文件名日期格式（用来反解日期）
 *   when  触发：段落名 + 要不要「写了才创建」
 *   to    产物：路径模板 + 输出模板文件（+ 文件头 / 空提示 / 附录）
 *   carry 结转（可选，kind: 'carry' 专用）：把上一个源文件里没做完的复选框搬过来
 *
 * ── 模板变量（写在 to.template / to.path / to.head 里）──────────────────
 *   {{date}} {{date:YYYY-MM-DD}} {{date:dddd}}  日期，格式用 moment token 子集
 *   {{name}} {{file}} {{link}}                  源文件名 / 路径 / 双链
 *   {{rule}} {{ruleid}}                         规则名 / 规则 id
 *   {{section}}          {{section:段落名}}      触发段落 / 指定段落的正文
 *   {{field:关键词}}     {{field:段落名 > 关键词}}  取 `- 标签：值` 这一行的值
 *                        {{field:2}}            纯数字 → 按出现序号取第 2 行
 *   {{checks:段落名}}    {{checks:段落名/子小节}}  取复选框行，保留勾选状态与备注
 *   {{fm:键}}                                    源文件 frontmatter 的字段
 *
 *   每个变量都能带默认值：`{{field:去哪|（今天没写）}}` —— 取不到时用竖线后面那段。
 *   不认识的变量（比如核心 Templates 的 {{title}}）**原样保留**，不会被吃掉。
 *
 * ── 三条安全约定（都是踩过坑换来的，别动）──────────────────────────────
 *   1. 原子写入：临时文件 + rename。直接覆盖会被文件监听器读到「写了一半」的中间态，
 *      结果是文件里两份内容交错拼贴（真事故，2026-10-07）。
 *   2. auto 标记：插件只管标记之间的区域，标记外面你手写的东西永不覆盖；
 *      文件存在但没有标记 → 判定是你手建的，直接跳过不动。
 *      同时兼容第一版的 `wb:auto` 标记，老文件无缝衔接。
 *   3. 只在内容真的变了才落盘：否则会「写入 → 触发 modify → 再写入」无限循环。
 *
 * ── 开发约定：纯函数核心与插件壳分居同一个文件 ──────────────────────────
 * 不引打包器，同一份 main.js 既能被 Obsidian 加载，又能被 Node 直接 require
 * 跑单元测试（见文件末尾的 `module.exports`）。
 * ========================================================================== */

'use strict';

/* ------------------------------------------------------------- 依赖探测 ---- */

let obsidianApi = null;
try { obsidianApi = require('obsidian'); } catch (e) { obsidianApi = null; }

let fsMod = null;
let pathMod = null;
try { fsMod = require('fs'); pathMod = require('path'); } catch (e) { fsMod = null; pathMod = null; }

/* ----------------------------------------------------------------- 常量 ---- */

const AUTO_START = '<!-- template-derive:start -->';
const AUTO_END = '<!-- template-derive:end -->';

/** 第一版留下的标记，读到就用，不迁移（免得动用户文件）。 */
const LEGACY_PAIRS = [
  { start: '<!-- wb:auto:start -->', end: '<!-- wb:auto:end -->' }
];

const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';
const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 剥外壳之后还剩几个字才算「真的写了」。留 2 个字符的容错，`还行` 这种两字短句不漏。 */
const MIN_SUBSTANCE = 2;

const CARRY_MAX_GAP_DAYS = 7;
const DEBOUNCE_MS = 1600;

/** 兼容旧配置：第一版的 key 直接映射过来，升级时不会丢数据。 */
const LEGACY_RULE_FIELD_MAP = {
  carryFrom: 'from.folder',
  carrySection: 'when.section'
};

/* -------------------------------------------------------------- 日期工具 ---- */

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 'YYYY-MM-DD' → '星期三'。 */
function weekdayCN(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  return WEEKDAY_CN[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
}

/** 两个 YYYY-MM-DD 之间差几天。用 UTC 构造，绕开夏令时。 */
function daysBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a || ''));
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b || ''));
  if (!pa || !pb) return Infinity;
  const t1 = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const t2 = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((t2 - t1) / 86400000);
}

/** YYYY-MM-DD 往后挪 N 天（负数就是往前）。同样用 UTC，绕开夏令时。 */
function shiftDate(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    + Number(days || 0) * 86400000;
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/**
 * 渲染**核心 Daily Notes** 模板里的变量：`{{date:格式}}` `{{date}}` `{{time}}` `{{title}}`。
 *
 * 为什么要自己再实现一遍：核心插件的「打开今天的日记」只认今天这一份，
 * 想去明天就得自己算日期、自己把模板填出来，这一步走的就是这里。
 *
 * ★ 认不出来的 `{{...}}` 原样保留（和 `evalVar` 同一条红线）：
 *   别人的模板里可能混着别的插件的变量，吃掉就再也找不回来了。
 */
function renderDailyNoteVars(tpl, vars) {
  const v = vars || {};
  return String(tpl == null ? '' : tpl).replace(
    /\{\{\s*([^{}:\s]+)\s*(?::\s*([^{}]*?)\s*)?\}\}/g,
    (all, name, arg) => {
      const n = String(name || '').toLowerCase();
      // ★ 认得但**取不到值**的时候也原样留下，不要悄悄换成空串 ——
      //   宁可在文件里看到 {{date:YYYY}}，也别让我看不出这里本来是要填日期的。
      if (n === 'date') return v.date ? formatDate(v.date, String(arg == null ? '' : arg)) : all;
      if (n === 'time') return v.time == null ? all : String(v.time);
      if (n === 'title') return v.title == null ? all : String(v.title);
      return all;
    }
  );
}

/**
 * 日期格式化。只实现 moment 的常用 token 子集 ——
 * 有意和 Obsidian 核心 Templates 的 {{date:...}} 保持一致，
 * 这样用户从核心模板搬过来的写法不用改。
 * ★ 核心插件不支持日期偏移（没有 {{date+1d}} 这种东西），这里也不做。
 */
function formatDate(dateStr, fmt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const wd = new Date(y, mo - 1, d).getDay();
  return String(fmt == null || fmt === '' ? DEFAULT_DATE_FORMAT : fmt)
    .replace(/YYYY|YY|MM|DD|dddd|ddd|M|D/g, (t) => {
      switch (t) {
        case 'YYYY': return String(y);
        case 'YY': return String(y).slice(-2);
        case 'MM': return pad2(mo);
        case 'M': return String(mo);
        case 'DD': return pad2(d);
        case 'D': return String(d);
        case 'dddd': return WEEKDAY_CN[wd];
        case 'ddd': return WEEKDAY_CN[wd].replace(/^星期/, '周');
        default: return t;
      }
    });
}

/** 把 'YYYY-MM-DD' 这种格式串转成正则，用来从文件名反解日期。 */
function namePatternToRe(fmt) {
  const src = String(fmt == null || fmt === '' ? DEFAULT_DATE_FORMAT : fmt);
  const TOKENS = ['YYYY', 'YY', 'MM', 'DD', 'M', 'D'];
  const SRC_OF = { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{1,2})', M: '(\\d{1,2})', DD: '(\\d{1,2})', D: '(\\d{1,2})' };
  const order = [];
  let out = '^';
  let i = 0;
  while (i < src.length) {
    let hit = '';
    for (const k of TOKENS) if (src.startsWith(k, i)) { hit = k; break; }
    if (hit) { order.push(hit); out += SRC_OF[hit]; i += hit.length; }
    else { out += src[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return { re: new RegExp(out + '$'), order };
}

function dateFromFileName(base, fmt) {
  const p = namePatternToRe(fmt);
  const m = p.re.exec(String(base || ''));
  if (!m) return '';
  let y = '';
  let mo = '';
  let d = '';
  p.order.forEach((tok, idx) => {
    const v = m[idx + 1];
    if (tok === 'YYYY' || tok === 'YY') y = tok === 'YY' ? '20' + v : v;
    else if (tok === 'MM' || tok === 'M') mo = v;
    else if (tok === 'DD' || tok === 'D') d = v;
  });
  if (!y || !mo || !d) return '';
  return y + '-' + pad2(Number(mo)) + '-' + pad2(Number(d));
}

function detectEol(md) { return /\r\n/.test(String(md || '')) ? '\r\n' : '\n'; }

/**
 * 源文件名的「身份」。
 * 默认认为文件名就是日期（日记那套）；把日期格式写成 `*` 就表示
 * 「文件名任意，原样当 key」—— 这样非日期命名的笔记（`S03 树.md`）也能用，
 * 用 {{name}} / {{key}} 取名字，{{date}} 会是空的。
 */
function keyFromFileName(base, fmt) {
  const f = String(fmt == null ? '' : fmt).trim();
  if (f === '*' || f === '') return String(base == null ? '' : base);
  return dateFromFileName(base, f);
}

function normPath(p) { return String(p == null ? '' : p).replace(/\\/g, '/'); }

function dirOf(p) {
  const parts = normPath(p).split('/');
  parts.pop();
  return parts.join('/');
}

function baseOf(p) {
  const parts = normPath(p).split('/');
  return parts[parts.length - 1];
}

function stripExt(name) { return String(name || '').replace(/\.md$/i, ''); }

/* -------------------------------------------------------------- 段落解析 ---- */

/**
 * 把笔记切成 frontmatter + 若干「## 标题」段落。
 * 只认二级标题（`## ` 后面必须跟空白），所以 `### 计划` 不会被当成段落边界。
 */
function parseSections(md) {
  const text = String(md == null ? '' : md);
  const lines = text.split(/\r?\n/);
  const sections = [];
  let frontmatter = null;
  let cur = null;
  let i = 0;

  if (lines.length && lines[0].trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    if (j < lines.length) {
      frontmatter = lines.slice(1, j).join('\n');
      i = j + 1;
    }
  }

  for (; i < lines.length; i++) {
    const h = /^##(?!#)\s+(.+?)\s*$/.exec(lines[i]);
    if (h) {
      if (cur) cur.endLine = i;
      cur = { title: h[1], startLine: i, endLine: lines.length, body: '' };
      sections.push(cur);
      continue;
    }
    if (cur) cur.body += (cur.body ? '\n' : '') + lines[i];
  }
  for (const s of sections) s.body = s.body.replace(/\s+$/, '');
  return { frontmatter, lines, sections };
}

/** 先精确匹配标题，再退化成「包含」。用户在标题上多写两个字也认得出来。 */
function getSection(sections, title) {
  const list = sections || [];
  const want = String(title == null ? '' : title);
  if (!want) return null;
  for (const s of list) if (s.title === want) return s;
  for (const s of list) if (s.title.indexOf(want) >= 0) return s;
  return null;
}

/** 取 `### 子小节` 下面的正文（到下一个 `###` 为止）。 */
function subSectionBody(body, subTitle) {
  const lines = String(body == null ? '' : body).split(/\r?\n/);
  const want = String(subTitle == null ? '' : subTitle);
  const buf = [];
  let on = false;
  for (const ln of lines) {
    const h = /^###\s+(.+?)\s*$/.exec(ln);
    if (h) { on = h[1].indexOf(want) >= 0; continue; }
    if (on) buf.push(ln);
  }
  return buf.join('\n');
}

/**
 * 按 `###` 子小节把复选框切成一组一组（只保留真的有内容的组）。
 * 用来让「今天的计划」按课程分点输出 —— 平铺成一长串看不出哪条属于哪门课。
 */
function groupBySubSection(body) {
  const lines = String(body == null ? '' : body).split(/\r?\n/);
  const groups = [];
  let cur = { title: '', buf: [] };
  const push = () => { if (cur.title || cur.buf.join('').trim()) groups.push(cur); };
  for (const ln of lines) {
    const h = /^###\s+(.+?)\s*$/.exec(ln);
    if (h) { push(); cur = { title: h[1], buf: [] }; continue; }
    cur.buf.push(ln);
  }
  push();
  return groups
    .map((g) => ({ title: g.title, items: extractCheckboxItems(g.buf.join('\n')) }))
    .filter((g) => g.items.length);
}

function frontmatterValue(frontmatter, key) {
  if (!frontmatter || !key) return '';
  const re = new RegExp('^' + String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const m = re.exec(frontmatter);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

/* -------------------------------------------- 「到底写了没有」的判定 ---- */

const DECOR = new Set([
  '：', ':', '·', '、', '，', ',', '。', '.', '；', ';', '！', '!', '？', '?',
  '（', '）', '(', ')', '[', ']', '【', '】', '《', '》', '「', '」', '『', '』',
  '"', '"', '\'', '\'', '—', '－', '-', '–', '_', '*', '~', '`', '|', '/', '\\',
  '　', ' ', '\t', '\r', '\n'
]);

/**
 * 去掉 callout 块（从 `> [!note] ...` 起到连续 `>` 行结束）。
 *
 * ★ 这一步是必须的：模板里每个段都带一条「为什么这样写」的可折叠 callout，
 *   如果不过滤，判定逻辑会把提示文字当成「用户写了内容」，导致空日记也去生成文件。
 *   注意只滤 callout（`> [!`），普通的 `>` 引用不滤 —— 因为「今日金句」段本身
 *   就是一条普通引用，那才是用户写的内容。
 */
function stripCallouts(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const out = [];
  let inCallout = false;
  for (const ln of lines) {
    const isQuote = /^\s*>/.test(ln);
    if (/^\s*>\s*\[!/.test(ln)) { inCallout = true; continue; }
    if (inCallout && isQuote) continue;
    if (inCallout && !isQuote) inCallout = false;
    out.push(ln);
  }
  return out.join('\n');
}

/**
 * 把一段文字里的「外壳」全部剥掉，只留用户真正写的字。
 * 剥掉：HTML 注释、callout 提示块、标题行、引用符号、加粗标签、行内代码、
 * 空复选框、序号、「标签：」这种前缀（一行里可能有好几个，所以循环）、数字、标点。
 *
 * 空模板跑出来长度必须是 0；用户随手写两个字就会 ≥ 2。
 */
function cleanForSubstance(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = stripCallouts(t);
  t = t.replace(/^#{1,6}[^\n]*$/gm, ' ');
  t = t.replace(/^\s*>\s?/gm, ' ');
  t = t.replace(/\*\*[^*\n]*\*\*/g, ' ');
  t = t.replace(/`[^`\n]*`/g, ' ');
  t = t.replace(/^\s*[-*+]\s*\[[ xX]\]\s*/gm, ' ');
  t = t.replace(/^\s*(?:\d+[.)]\s*|[-*+]\s*)/gm, ' ');
  for (let k = 0; k < 8; k++) {
    const next = t.replace(/^[^：:\n]{1,40}[：:]/gm, ' ');
    if (next === t) break;
    t = next;
  }
  // ★ 这里**不要**再额外剥括号。模板里 `- **合上书，用自己的话写**（这章在说什么…）：`
  //   这种「标签后带括号说明」的行，靠上面那个循环已经能剥干净（括号里没有冒号，
  //   整个「（…）：」会被当成前缀一起剥掉）。而用户写的内容里恰恰很常用括号
  //   （书名《》、章节「（第 5 章）」），多剥一层反而会把真内容吃掉。
  let out = '';
  for (const ch of t) {
    if (ch >= '0' && ch <= '9') continue;
    if (DECOR.has(ch)) continue;
    out += ch;
  }
  return out;
}

function cleanLen(text) { return cleanForSubstance(text).length; }

/**
 * ★ 「整段只剩数字」的兜底。
 *
 * cleanForSubstance 会把阿拉伯数字**全部**丢掉 —— 那是为了让模板自带的打分占位
 * （`- 精力：　1/ 5`）不算内容，否则空日记也会凭空生成文件。
 * 但代价是：用户真的只写了数字（`123`、`30 词` 里的数字被剥完只剩词还行，
 * 整段纯数字则一个字不剩）时会被判成「没写」，衍生文件死活不生成。
 *
 * 所以只在 cleanLen 已经是 0 时才看这里，并且**先剔掉 `n/5` 打分形态**，
 * 这样成长轨迹的空模板（`1/ 5` 铺满）不会被误判成写了。
 * 返回「非空格、非装饰符、非数字的其它字符」为 0 时的数字个数，否则记 0
 * （有别的内容时该由 cleanLen 判，别在这里重复计）。
 */
function digitLen(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = stripCallouts(t);
  t = t.replace(/^#{1,6}[^\n]*$/gm, ' ');
  t = t.replace(/^\s*>\s?/gm, ' ');
  t = t.replace(/\*\*[^*\n]*\*\*/g, ' ');
  t = t.replace(/`[^`\n]*`/g, ' ');
  t = t.replace(/^\s*[-*+]\s*\[[ xX]\]\s*/gm, ' ');
  t = t.replace(/^\s*(?:\d+[.)]\s*|[-*+]\s*)/gm, ' ');
  for (let k = 0; k < 8; k++) {
    const next = t.replace(/^[^：:\n]{1,40}[：:]/gm, ' ');
    if (next === t) break;
    t = next;
  }
  t = t.replace(/\d{1,3}\s*\/\s*5/g, ' ');
  let digits = 0;
  let other = 0;
  for (const ch of t) {
    if (ch >= '0' && ch <= '9') { digits++; continue; }
    if (DECOR.has(ch)) continue;
    other++;
  }
  return other === 0 ? digits : 0;
}

/** 这一段到底有没有写东西。 */
function hasSubstance(text) {
  return cleanLen(text) >= MIN_SUBSTANCE || digitLen(text) >= MIN_SUBSTANCE;
}

/** 光打了分没写字也算写了（成长轨迹那类段落用）。 */
function hasSubstanceOrScore(text) {
  const t = String(text == null ? '' : text);
  if (hasSubstance(t)) return true;
  if (/[0-9]{1,3}\s*\/\s*5/.test(t)) return true;
  if (/(精力|专注|自主|胜任|联结)\s*[：:]\s*[0-9]/.test(t)) return true;
  return false;
}

/** 规则的 when 段落到不到「该生成」的门槛。 */
function substanceCheck(body, when) {
  const w = when || {};
  const t = String(body == null ? '' : body);
  const min = w.minChars > 0 ? w.minChars : MIN_SUBSTANCE;
  if (min !== MIN_SUBSTANCE) return cleanLen(t) >= min;
  if (w.scoreAware) return hasSubstanceOrScore(t);
  return hasSubstance(t);
}

/* ---------------------------------------------------------------- 取值 ---- */

/**
 * `- **标签**：值` 或 `- 标签：值`。
 * ★ 标签后面的括号说明要允许存在 —— 模板里写成
 *   `- **合上书，用自己的话写**（这章在说什么 + 我还记得什么）：`
 *   旧写法 `\*\*(.+?)\*\*\s*[：:]` 要求 `**` 后面紧跟冒号，
 *   碰到括号就直接匹配失败，这一行的内容会被整个丢掉。
 */
function extractLabeledBullets(text) {
  const out = [];
  for (const ln of String(text == null ? '' : text).split(/\r?\n/)) {
    let m = /^\s*[-*+]\s*\*\*(.+?)\*\*\s*(?:[（(][^）)\n]*[）)])?\s*[：:]\s*([\s\S]*)$/.exec(ln);
    if (!m) m = /^\s*[-*+]\s*([^：:*\[\]\n]{1,40}?)\s*[：:]\s*([\s\S]*)$/.exec(ln);
    if (m) { out.push({ label: m[1].trim(), value: m[2].trim() }); continue; }
    // ★ 缩进的续行并入上一条。在同一条下面换行接着写是很自然的动作，
    //   以前这些行会被整段丢掉（`- **去哪**：123` 下面另起一行写的 23 就没了）。
    //   排除小标题，免得把段落里的 ### 小节名吞进上一条的值里。
    if (out.length && /^[ \t]+\S/.test(ln) && !/^[ \t]*#{1,6}\s/.test(ln)) {
      const v = ln.trim();
      if (v) out[out.length - 1].value += '\n' + v;
    }
  }
  return out;
}

/** 按关键词取第一个命中的 bullet 的值。 */
function pickValue(text, keywords) {
  const bs = extractLabeledBullets(text);
  for (const b of bs) {
    for (const k of keywords) if (b.label.indexOf(k) >= 0) return b.value;
  }
  return '';
}

/** `精力：4 / 5` 这种，取成 { 精力: '4' }。 */
function extractScores(text) {
  const out = {};
  const t = String(text == null ? '' : text);
  const re = /(精力|专注|自主|胜任|联结)\s*[：:]\s*([0-9]{1,3}(?:\.[0-9])?)/g;
  let m;
  while ((m = re.exec(t))) out[m[1]] = m[2];
  return out;
}

/* 一行是「完成：xxx」吗（行内的旧写法）。 */
const DONE_FIELD_RE = /完成\s*[：:]\s*([\s\S]*)$/;
/* 一行是「完成：xxx」吗（写在目标下面、缩进的那一行）。 */
const DONE_LINE_RE = /^\s*(?:完成|结果)\s*[：:]\s*([\s\S]*)$/;
/* 完成行的缩进：2 空格 = Markdown 里列表项的续行。 */
const DONE_INDENT = '  ';
/* 完成行的默认标签。可被规则里的 carry.suffix 覆盖。 */
const DONE_LABEL = '完成：';
const CHECKBOX_LINE_RE = /^\s*[-*+]\s*\[([ xX])\]\s*([\s\S]*)$/;

/**
 * 复选框项：**目标一行、完成结果一行**。
 *
 *     - [ ] ↺ 背 30 词（早饭后）
 *       完成：对了 9 道
 *
 * done 的判定有两条：勾上了，**或者**完成行真的写了东西。
 * 只判复选框会漏掉「没勾但写了结果」的情况。
 *
 * 旧的内联写法（`- [ ] 背 30 词　完成：对了 9 道`）照样认，老日记不用改。
 */
function extractCheckboxItems(text) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.item) {
      out.push({
        done: cur.box || cleanLen(cur.note) >= MIN_SUBSTANCE,
        item: cur.item,
        note: cur.note,
        raw: cur.raw
      });
    }
    cur = null;
  };

  for (const ln of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = CHECKBOX_LINE_RE.exec(ln);
    if (m) {
      let rest = m[2];
      let note = '';
      const d = DONE_FIELD_RE.exec(rest);
      if (d) { note = d[1].trim(); rest = rest.slice(0, d.index); }
      const item = rest.replace(/^\s*↺\s*/, '').replace(/[\s→\-–—]+$/, '').trim();
      // `- [ ] 完成：xxx`（目标那行空着、结果写了）→ 结果归给上一条，不单独成项
      if (!item && note && cur) { if (!cur.note) cur.note = note; continue; }
      flush();
      cur = { box: m[1].toLowerCase() === 'x', item, note, raw: ln };
      continue;
    }
    if (!cur) continue;
    // 续行：缩进了、而且不是小标题
    if (/^\s+\S/.test(ln) && !/^\s*#{1,6}\s/.test(ln)) {
      const dl = DONE_LINE_RE.exec(ln);
      if (dl && !cur.note) cur.note = dl[1].trim();
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/** 旧名字，保留以免外部脚本失效。 */
const extractCheckboxLines = extractCheckboxItems;

/**
 * 复选框项 → Markdown。目标一行；**写了结果才补**缩进的完成行。
 * ★ 没写结果就不补空行 —— 产物里留一排空的「完成：」只会变成噪声。
 */
function checkboxLinesToMd(lines) {
  const out = [];
  for (const p of (lines || [])) {
    out.push('- [' + (p.done ? 'x' : ' ') + '] ' + p.item);
    if (p.note) out.push(DONE_INDENT + DONE_LABEL + p.note);
  }
  return out.join('\n');
}

/* --------------------------------------------------- 回车续行（输入体验）----
 *
 * 为什么需要这一段：`- [ ]` 是 Obsidian 原生语法，在写满的任务行末尾按回车，
 * 它确实会帮你续出 `- [ ] `；但「完成：」那一行是我们自己定的格式，编辑器
 * 根本不知道它存在，只当它是「某个列表项下面缩进的一段普通文字」，按回车只会
 * 接着缩进。更要命的是：任务行**空着**（只有 `- [ ] `）时按回车，CommonMark
 * 规定空列表项要结束列表，Obsidian 老老实实照做 —— 方框当场消失。
 * 所以「按回车自动补出这两行」只能在插件里接管，见文件末尾的 keydown 监听。
 *
 * 下面是纯函数：算出「光标在这一行按回车」该干什么，不知道 Obsidian 的存在。
 */

/**
 * 空方框后面光标该落在哪一列：方框本身 + 一个空格。
 * 不能直接拿 `m[0].length - m[2].length` —— 模板里的占位写的是 `- [ ] 　`
 * （末尾是全角空格，为了让那一行不至于「空着」），而 `\s` 认得全角空格，
 * 于是 m[2] 是空串、算出来的列会多出一格，光标落到全角空格后面，
 * 用户接着打字目标前面就多一个空格。
 */
function caretAfterCheckbox(m) {
  return m[0].replace(/\s+$/, '').length + 1;
}

/** 一行是不是「缩进的『完成：xxx』」—— 缩进是必须的，顶格的「完成：」不归我们管。 */
function isDoneLine(s) {
  const t = String(s == null ? '' : s);
  return /^[ \t]+\S/.test(t) && DONE_LINE_RE.test(t);
}

/**
 * 从 at 往上找最近的复选框行，返回 `{ indent, text }`（缩进 + 目标文字）。
 *
 * 两件事都要：`text` 用来判断「这一条到底写没写东西」；`indent` 用来算
 * 下一条该从哪一列开始 —— 完成行比目标行多缩进一级，续行必须回到**目标行**
 * 的缩进，不然嵌套列表会每按一次回车就往右跑一格。
 *
 * 找不到就返回 null。
 */
function nearestItem(getLine, at) {
  for (let i = at - 1; i >= 0 && i > at - 40; i--) {
    const ln = getLine(i);
    if (ln == null) break;
    const m = CHECKBOX_LINE_RE.exec(ln);
    if (m) {
      let rest = m[2];
      const d = DONE_FIELD_RE.exec(rest);
      if (d) rest = rest.slice(0, d.index);
      return {
        indent: /^[ \t]*/.exec(ln)[0],
        text: rest.replace(/^\s*↺\s*/, '').replace(/[\s→\-–—]+$/, '').trim()
      };
    }
    if (/^[ \t]*#{1,6}\s/.test(ln)) break;                    // 撞到小标题就停
    if (!/^[ \t]*$/.test(ln) && !/^[ \t]+\S/.test(ln)) break;  // 撞到顶格的普通行也停
  }
  return null;
}

/**
 * 在 lineNo 这一行末尾按回车，应该干什么？返回 null 表示「不接管」。
 *
 *   { mode: 'cursor', line, ch }                      把光标挪过去，不动内容
 *   { mode: 'insert', line, text, cursor:{back,ch} }  在 line 行末插入 text，
 *                                                     光标落在「倒数第 back 行」的 ch 列
 *
 * 三种情况一律交回 Obsidian，一个字都不改：
 *   · 空方框行 —— 用户还没写目标，这时候续行只会灌一堆空骨架；
 *   · 旧的内联写法（`- [ ] 目标　完成：结果`）—— 他不用两行格式；
 *   · 目标和结果都空的「空条目」—— 连按回车本来就该能退出列表。
 */
function taskEnterAction(getLine, lineNo, opts) {
  const o = opts || {};
  const label = o.label == null ? DONE_LABEL : String(o.label || DONE_LABEL);
  const pad = o.indent == null ? DONE_INDENT : String(o.indent);
  const cur = getLine(lineNo);
  if (cur == null) return null;
  const next = getLine(lineNo + 1);

  const cb = CHECKBOX_LINE_RE.exec(cur);
  if (cb) {
    // ★ 先判「还没写目标」：这种时候一个字都不改。
    //   —— 模板里的空占位就是这一种。要是接管了、把光标送到下面那行，
    //   用户接着打字就把「目标」打进了「完成：」那一行，格式当场就坏了。
    //   交回 Obsidian 反而安全：它按 CommonMark 的老规矩（空列表项回车退出列表）处理，
    //   方框没了按一下撤销就回来，至少不会写错行。
    if (!cb[2].trim() || DONE_FIELD_RE.test(cb[2])) return null;
    const indent = /^[ \t]*/.exec(cur)[0];
    // 下面已经有缩进的「完成：」行了 → 别新开一行，直接把光标送过去填结果
    if (isDoneLine(next)) return { mode: 'cursor', line: lineNo + 1, ch: next.length };
    return {
      mode: 'insert',
      line: lineNo,
      text: '\n' + indent + pad + label,
      cursor: { back: 0, ch: (indent + pad + label).length }
    };
  }

  // ★ 小标题（### 及以下）行尾按回车 → 直接给一组空占位，光标停在方框后面。
  //   这样新开一个学科 / 新开一类的时候不用手敲那两行 —— 敲出来还容易把
  //   缩进写错（完成行必须比目标行缩一级，否则插件认不出这是一对）。
  //   下面已经有空占位了就把光标送过去，不重复插。
  const h = /^[ \t]*(#{3,6})[ \t]+(.+?)[ \t]*$/.exec(cur);
  if (h) {
    if (typeof o.ch === 'number' && o.ch < cur.replace(/\s+$/, '').length) return null;
    const nb = CHECKBOX_LINE_RE.exec(next == null ? '' : next);
    if (nb && !nb[2].trim() && !DONE_FIELD_RE.test(nb[2])) {
      return { mode: 'cursor', line: lineNo + 1, ch: caretAfterCheckbox(nb) };
    }
    // 下面已经躺着一条写好的待办（或者别的正文）→ 别插，他多半只是想换行
    if (nb) return null;
    if (next != null && next.trim() !== '' && !/^[ \t]*#{1,6}\s/.test(next)) return null;
    const hind = /^[ \t]*/.exec(cur)[0];
    const head = hind + '- [ ] ';
    return {
      mode: 'insert',
      line: lineNo,
      text: '\n' + head + '\n' + hind + pad + label,
      cursor: { back: 1, ch: head.length }
    };
  }

  const dn = DONE_LINE_RE.exec(cur);
  if (dn) {
    const indent = /^[ \t]*/.exec(cur)[0];
    if (!indent) return null;
    // 下面已经有一组空占位了 → 光标跳过去就行
    const nb = CHECKBOX_LINE_RE.exec(next == null ? '' : next);
    if (nb && !nb[2].trim()) {
      return { mode: 'cursor', line: lineNo + 1, ch: caretAfterCheckbox(nb) };
    }
    const up = nearestItem(getLine, lineNo);
    if (!dn[1].trim() && !(up && up.text)) return null;
    // 续行要回到**目标行**那一列，不是完成行那一列
    const base = up ? up.indent : (indent.slice(-pad.length) === pad ? indent.slice(0, -pad.length) : indent);
    const head = base + '- [ ] ';
    return {
      mode: 'insert',
      line: lineNo,
      text: '\n' + head + '\n' + base + pad + label,
      cursor: { back: 1, ch: head.length }
    };
  }

  return null;
}

/* --------------------------------------- 学科标题行回车 → 建当天笔记 ---- */

/**
 * 「### 学科名」那一行按回车，直接把这门课今天的笔记建出来并跳过去写。
 *
 * 为什么要自己接管：日记里的课程清单是纯文本小标题，Obsidian 不知道
 * `### Fundamentals of …` 和 `Subjects/Fundamentals of …/` 是同一回事，
 * 按回车只会另起一个空行。而当天笔记的命名（日期、所在文件夹）每次都一样，
 * 手建就是重复劳动 —— 这正是该交给插件的那种活。
 *
 * 和上面 taskEnterAction 一样是纯函数：算「该建哪个文件」，不碰文件系统。
 * 「这个标题到底是不是学科」交给 resolve 回调（壳里查 Subjects/ 下有没有
 * 同名文件夹），所以「### 阅读」「### 锻炼」这些天然不命中。
 */
const SUBJECT_DEFAULT_ROOT = 'Subjects';
const SUBJECT_DEFAULT_PATH = 'Subjects/{{name}}/笔记/{{date:YYYY-MM-DD}}.md';
const SUBJECT_DEFAULT_TPL = 'Templates/学科笔记模板.md';

/** 学科笔记模板变量：{{course}} {{name}} {{date[:格式]}} {{weekday}} {{diary}}。未知的原样留着。 */
function renderSubjectVars(tpl, vars) {
  if (tpl == null) return '';
  const v = vars || {};
  return String(tpl).replace(VAR_RE, (whole, name, arg, dflt) => {
    let out;
    if (name === 'course' || name === 'name') out = v.name == null ? '' : String(v.name);
    else if (name === 'date') out = v.date ? formatDate(v.date, (arg || '').trim() || DEFAULT_DATE_FORMAT) : '';
    else if (name === 'weekday') out = v.date ? weekdayCN(v.date) : '';
    else if (name === 'diary') out = v.diary ? '[[' + stripExt(normPath(v.diary)) + ']]' : '';
    else return whole;                                  // 未知变量原样留着，别乱吃
    if (out === '') out = dflt == null ? '' : dflt;
    return out;
  });
}

/** 目标路径归一化：挡掉 `..` 和多余斜杠，末尾补 `.md`。 */
function normTarget(raw) {
  const parts = [];
  for (const seg of normPath(raw).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const p = parts.join('/');
  return /\.md$/i.test(p) ? p : p + '.md';
}

/**
 * 这一行里有没有指向 link 的双链？有就别重复插，直接打开。
 *
 * 只认两种写法：完整路径，或者**不带任何斜杠**的纯文件名短链接
 * （`[[2026-10-07|今天的课]]`）。带路径又不等于完整路径的一律不算 ——
 * `[[Personal/Diary/2026-10-07]]` 文件名撞了但不是同一个文件，认了就会漏插链接。
 */
function hasLinkTo(line, link) {
  const t = String(line == null ? '' : line);
  if (!t || !link) return false;
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(t))) {
    const raw = m[1].split('|')[0].split('#')[0].trim();
    if (!raw) continue;
    const inner = stripExt(raw);
    if (inner === link) return true;
    if (raw.indexOf('/') < 0 && inner === baseOf(link)) return true;
  }
  return false;
}

/**
 * 标题行末尾按回车该干什么。返回 `{ mode:'subject', name, path, linked }`，
 * 或者 null（不接管，交回 Obsidian 老老实实插一个空行）。
 *
 * 不接管的四种：不是标题行 / 标题是空的 / resolve 说这不是学科 /
 * 光标不在行尾（行中间按回车是想把标题拆成两行，不能抢）。
 */
function subjectEnterAction(getLine, lineNo, ch, resolve, opts) {
  const o = opts || {};
  const cur = getLine(lineNo);
  if (cur == null) return null;
  const m = /^[ \t]*(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(cur);
  if (!m) return null;
  if (typeof ch === 'number' && ch < cur.replace(/\s+$/, '').length) return null;
  const title = m[2].replace(/^\s*↺\s*/, '').trim();
  if (!title) return null;
  const name = typeof resolve === 'function' ? resolve(title) : null;
  if (!name) return null;
  const path = normTarget(renderSubjectVars(o.path || SUBJECT_DEFAULT_PATH, {
    name: name, date: o.date || '', diary: o.diary || ''
  }));
  return {
    mode: 'subject',
    name: name,
    path: path,
    linked: hasLinkTo(getLine(lineNo + 1), stripExt(path))
  };
}

/* ----------------------------- Shift+回车：在计划段里再开一个小节 ---- */

const SECTION_DEFAULT_TITLES = ['今日计划'];

/**
 * Shift+回车：在「今日计划」这一段里**再开一个小节** —— 一整个 `###` 加一组空占位。
 *
 * 一个按键换三行，值得的原因是：手敲这三行最容易错的就是完成行的缩进，
 * 少敲两个空格，插件就认不出「这是一对」，结转和输出的时候整条会静默丢掉。
 *
 * 返回 `{ mode:'insert', line, text, cursor }`，line 是「插在哪一行后面」，
 * 光标停在 `### ` 后面等着打学科名。
 *
 * 不生效（返回 null）：往上找到的 `##` 段落标题不在允许的那个名单里 ——
 * 今日阅读、今日复盘那些段落一个字都不动。
 */
function sectionEnterAction(getLine, lineNo, opts) {
  const o = opts || {};
  const titles = Array.isArray(o.titles) && o.titles.length ? o.titles : SECTION_DEFAULT_TITLES;
  const label = o.label == null ? DONE_LABEL : String(o.label || DONE_LABEL);
  const pad = o.indent == null ? DONE_INDENT : String(o.indent);
  if (getLine(lineNo) == null) return null;

  // 往上找最近的 ## 段落标题
  let h2 = '';
  for (let i = lineNo; i >= 0 && i > lineNo - 200; i--) {
    const ln = getLine(i);
    if (ln == null) break;
    const m = /^[ \t]*(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(ln);
    if (m && m[1].length === 2) { h2 = m[2].trim(); break; }
  }
  if (titles.indexOf(h2) < 0) return null;

  // 往下走到当前小节的末尾：撞到下一个标题或者 --- 分隔线就停，空行不算数
  let end = lineNo;
  for (let i = lineNo + 1; i < lineNo + 400; i++) {
    const ln = getLine(i);
    if (ln == null) break;
    if (/^[ \t]*#{1,6}\s/.test(ln)) break;
    if (/^[ \t]*---+\s*$/.test(ln)) break;
    if (ln.trim() !== '') end = i;
  }
  return {
    mode: 'insert',
    line: end,
    text: '\n\n### \n- [ ] \n' + pad + label,
    cursor: { back: 2, ch: '### '.length }
  };
}

function normKey(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[\s　·、，,。.：:;；!！?？()（）\[\]【】"'`*_\-–—→]/g, '');
}

/* ---------------------------------------------------------- 模板引擎 ---- */

/**
 * 变量正则。
 *   {{name}}                  → g1=name
 *   {{name:参数}}              → g1=name, g2=参数
 *   {{name:参数|默认值}}        → g1=name, g2=参数, g3=默认值
 *   {{name|默认值}}            → g1=name, g3=默认值
 * 参数和默认值里都不允许出现 `{ } |`，所以不会误吃后面跟着的别的变量。
 */
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::([^|{}]*?))?\s*(?:\|\s*([^{}]*?))?\s*\}\}/g;

function sectionBodyFrom(ctx, title) {
  const sec = getSection(ctx.sections, title);
  return sec ? sec.body : '';
}

/**
 * 取段落正文，顺手滤掉 callout 块。
 * ★ 模板里每个段都带一条「为什么这样写」的折叠说明，那不是用户写的内容 ——
 *   不滤的话，产物文件里会混进一堆注释，而且会把「写了没有」的判定带偏。
 *   用户自己写的普通 `>` 引用不受影响（只滤 `> [!`）。
 */
function contentOf(ctx, title) {
  const body = title ? sectionBodyFrom(ctx, title) : (ctx.sectionBody || '');
  return stripCallouts(body);
}

/**
 * `{{field:关键词}}` / `{{field:段落名 > 关键词}}`。
 * 关键词可以用逗号写多个候选（`{{field:去哪,目标,Feed up}}`）——
 * 用户换个措辞写标签也能取到，这是「标签匹配」这套设计里唯一的容错手段。
 * 纯数字则按出现顺序取第 n 个「标签：值」行。
 */
function fieldValue(ctx, arg) {
  const a = String(arg == null ? '' : arg).trim();
  if (!a) return '';
  let body = contentOf(ctx, '');
  let key = a;
  const gt = a.indexOf('>');
  if (gt >= 0) {
    const title = a.slice(0, gt).trim();
    key = a.slice(gt + 1).trim();
    body = contentOf(ctx, title);
  }
  if (!key) return '';
  // 纯数字 → 按出现顺序取第 n 个「标签：值」行。
  // 这是给「用户在段落里改了标签措辞」留的退路：关键词对不上了，还能按位置取。
  if (/^\d+$/.test(key)) {
    const bs = extractLabeledBullets(body);
    const hit = bs[Number(key) - 1];
    return hit ? hit.value : '';
  }
  const keys = key.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return pickValue(body, keys);
}

/**
 * `{{lines:[段落 > ]关键词}}` —— 和 `{{field:}}` 取的是同一个值，但按行拆成 `- ` 列表。
 *
 * 存在的理由：用户在同一条下面换行写了两三点时，`{{field:}}` 会把它们塞进一行，
 * 而且值里有换行的话，写在 `> ` 引用块里的模板会让第二行**掉出**引用块。
 * 用这个变量就是一行一个点，和「目标一行、完成结果一行」那套格式保持一致。
 */
function linesValue(ctx, arg) {
  const v = String(fieldValue(ctx, arg) || '').trim();
  if (!v) return '';
  return v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => '- ' + s).join('\n');
}

/** `{{score:精力}}` → `4 / 5`。取不到返回空串，交给默认值。 */
function scoreValue(ctx, arg) {
  const s = extractScores(ctx.sectionBody || '');
  const keys = String(arg == null ? '' : arg).split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  for (const k of keys) if (s[k] != null) return s[k] + ' / 5';
  return '';
}

function checksValue(ctx, arg) {
  const a = String(arg == null ? '' : arg).trim();
  if (!a) return '';
  const parts = a.split('/').map((s) => s.trim()).filter(Boolean);
  let body = contentOf(ctx, parts[0]);
  if (!body) return '';
  if (parts[1]) body = subSectionBody(body, parts[1]);
  const lines = extractCheckboxItems(body);
  if (!lines.length) return '';
  // ★ 没指定子小节、而源段落本身就是按 ### 分小节的 → 照小节分组输出。
  //   `{{checks:今日计划/阅读}}` 这种已经点名了子小节的不分组（parts[1] 有值）。
  if (!parts[1]) {
    const groups = groupBySubSection(body);
    if (groups.length > 1) {
      return groups.map((g) => {
        const md = checkboxLinesToMd(g.items);
        return md ? '### ' + (g.title || '其它') + '\n\n' + md : '';
      }).filter(Boolean).join('\n\n');
    }
  }
  return checkboxLinesToMd(lines);
}

/**
 * 求值一个变量。
 * 返回 undefined 表示「不认识这个变量」—— 调用方会原样保留，
 * 这样核心 Templates 的 {{title}} 之类不会被我们吃掉。
 */
function evalVar(name, arg, ctx) {
  const n = String(name || '').toLowerCase();
  switch (n) {
    case 'date':
      return formatDate(ctx.date, arg || ctx.dateFormat || DEFAULT_DATE_FORMAT);
    case 'name': return ctx.name || '';
    case 'key': return ctx.key || '';
    case 'file': return ctx.file || '';
    case 'link': return ctx.file ? '[[' + ctx.file + ']]' : '';
    case 'rule': return ctx.ruleName || '';
    case 'ruleid': return ctx.ruleId || '';
    case 'section':
      return String(contentOf(ctx, arg) || '').trim();
    case 'field': return fieldValue(ctx, arg);
    case 'lines': return linesValue(ctx, arg);
    case 'score': return scoreValue(ctx, arg);
    case 'checks': return checksValue(ctx, arg);
    case 'fm':
    case 'frontmatter': return frontmatterValue(ctx.frontmatter, arg);
    default: return undefined;
  }
}

/**
 * 渲染模板。空值会退到默认值（`{{x|默认}}`），没默认值就变成空串。
 * 未知变量原样留着。
 */
function renderTemplate(tpl, ctx) {
  if (tpl == null) return '';
  return String(tpl).replace(VAR_RE, (whole, name, arg, dflt) => {
    const v = evalVar(name, arg == null ? '' : String(arg).trim(), ctx);
    if (v === undefined) return whole;
    const s = v == null ? '' : String(v);
    if (s === '') return dflt == null ? '' : dflt;
    return s;
  });
}

/** 路径模板：渲染后归一化，顺手挡掉 `..` 和开头多余的斜杠。 */
function renderPath(tpl, ctx) {
  return normTarget(renderTemplate(tpl, ctx));
}

/** 建渲染上下文。date 在「文件名任意」模式下可能是空串，key 一定非空。 */
function buildCtx(o) {
  const parsed = parseSections(o.sourceMd);
  const file = normPath(o.file);
  const name = stripExt(baseOf(file));
  const dateFormat = (o.rule && o.rule.from && o.rule.from.dateFormat) || DEFAULT_DATE_FORMAT;
  return {
    file,
    name,
    key: keyFromFileName(name, dateFormat),
    date: o.date == null ? '' : o.date,
    dateFormat,
    ruleName: (o.rule && o.rule.name) || '',
    ruleId: (o.rule && o.rule.id) || '',
    sourceMd: o.sourceMd,
    frontmatter: parsed.frontmatter,
    sections: parsed.sections,
    sectionTitle: (o.section && o.section.title) || '',
    sectionBody: (o.section && o.section.body) || ''
  };
}

/* -------------------------------------------------------- auto 标记区 ---- */

/**
 * 在正文里找 auto 标记区。先认新标记，再认第一版的 `wb:auto`，
 * 保证老产物文件继续被维护、不会被当成「你手建的」而跳过。
 */
function findAutoBlock(md) {
  const t = String(md == null ? '' : md);
  const pairs = [{ start: AUTO_START, end: AUTO_END }].concat(LEGACY_PAIRS);
  for (const pair of pairs) {
    const s = t.indexOf(pair.start);
    if (s < 0) continue;
    const e = t.indexOf(pair.end, s + pair.start.length);
    if (e < 0) continue;
    return {
      start: s, end: e,
      innerStart: s + pair.start.length,
      innerEnd: e,
      startTag: pair.start, endTag: pair.end
    };
  }
  return null;
}

function hasAutoBlock(md) { return !!findAutoBlock(md); }

/** 只替换标记之间的内容，标记外一个字都不碰。 */
function upsertAutoBlock(md, inner) {
  const t = String(md == null ? '' : md);
  const b = findAutoBlock(t);
  if (!b) return t;
  const clean = String(inner == null ? '' : inner).replace(/\s+$/, '');
  return t.slice(0, b.innerStart) + '\n' + clean + '\n' + t.slice(b.innerEnd);
}

/** 组装一个全新产物文件：文件头 + auto 标记区 + 附录。 */
function wrapNew(head, inner, tail) {
  const h = String(head == null ? '' : head).replace(/\s+$/, '');
  const i = String(inner == null ? '' : inner).replace(/\s+$/, '');
  const t = String(tail == null ? '' : tail).replace(/\s+$/, '');
  let out = '';
  if (h) out += h + '\n\n';
  out += AUTO_START + '\n' + i + '\n' + AUTO_END + '\n';
  if (t) out += '\n' + t + '\n';
  return out;
}

/* ---------------------------------------------------------- 规则匹配 ---- */

function isUnder(fileDir, folder) {
  const f = normPath(folder).replace(/\/+$/, '');
  if (!f) return true;
  const d = normPath(fileDir).replace(/\/+$/, '');
  return d === f || d.indexOf(f + '/') === 0;
}

/**
 * 这个文件是不是这条规则的源？只看两件事：在不在源文件夹下、文件名能不能解出 key。
 */
function fileMatchesRule(rule, filePath) {
  if (!rule || rule.enabled === false) return false;
  const p = normPath(filePath);
  if (!/\.md$/i.test(p)) return false;
  const from = rule.from || {};
  if (!isUnder(dirOf(p), from.folder)) return false;
  return !!keyFromFileName(stripExt(baseOf(p)), from.dateFormat);
}

/** 某个文件命中的全部规则（按数组顺序）。 */
function matchRules(rules, filePath) {
  return (rules || []).filter((r) => fileMatchesRule(r, filePath));
}

/* -------------------------------------------------------------- 结转 ---- */

/**
 * 把上一个源文件里没做完的复选框搬到今天的源文件里。
 *
 * 规则：
 *   - 只搬「没勾上 **且** 完成行还没写东西」的条目（两个条件都要判）
 *   - 今天已经有同样一条（忽略空格和标点）就不再重复搬
 *   - 尽量放回它原来所在的 `### 子小节`；找不到就统一挂到孤儿标题下
 *
 * ★ 孤儿项的落点：从段落末尾往回跳过空行和 `---` 分隔线，插在最后一条实质内容之后。
 *   不这么做的话，它会落到分隔线下面、紧贴着下一个 `##` 标题，看着像掉出来的。
 */
function carryOver(o) {
  const opts = o || {};
  const sectionTitle = opts.section || '';
  const mark = opts.mark || '↺';
  // suffix 以前是「拼在条目行尾」，现在完成结果单独占一行，所以它变成
  // 「完成行的标签」。两种写法都归一成「完成：」，老配置不用改。
  const doneLabel = String(opts.suffix == null ? DONE_LABEL : opts.suffix)
    .replace(/^[\s　→\-–—]+/, '').trim() || DONE_LABEL;
  const orphanHeading = String(opts.orphanHeading || ('### ' + mark + ' 结转自 {{prevDate}}'))
    .replace(/\{\{\s*prevDate\s*\}\}/g, opts.prevDate || '上一天');

  const today = parseSections(opts.todayMd);
  const plan = getSection(today.sections, sectionTitle);
  if (!plan) return { changed: false, text: opts.todayMd, added: 0 };

  const prevPlan = getSection(parseSections(opts.prevMd).sections, sectionTitle);
  if (!prevPlan) return { changed: false, text: opts.todayMd, added: 0 };

  // ★ 这里要自己走一遍行（不能直接调 extractCheckboxItems），因为还得记住
  //   每一项属于哪个 `### 子小节` —— 搬过去的时候要放回原位。
  //   完成行是缩进的续行，所以「一项」要横跨两行，不能一行一行独立判断。
  const prevOpen = [];
  let curSub = '';
  let curItem = null;
  const flushPrev = () => {
    if (curItem && curItem.item && !curItem.box && cleanLen(curItem.note) < MIN_SUBSTANCE) {
      prevOpen.push({ sub: curItem.sub, item: curItem.item });
    }
    curItem = null;
  };
  for (const ln of prevPlan.body.split(/\r?\n/)) {
    const h = /^###\s+(.+?)\s*$/.exec(ln);
    if (h) { flushPrev(); curSub = h[1]; continue; }
    const m = CHECKBOX_LINE_RE.exec(ln);
    if (m) {
      flushPrev();
      let rest = m[2];
      let note = '';
      const d = DONE_FIELD_RE.exec(rest);
      if (d) { note = d[1].trim(); rest = rest.slice(0, d.index); }
      const item = rest.replace(/^\s*↺\s*/, '').replace(/[\s→\-–—]+$/, '').trim();
      curItem = { sub: curSub, box: m[1].toLowerCase() === 'x', item, note };
      continue;
    }
    if (!curItem) continue;
    if (/^\s+\S/.test(ln) && !/^\s*#{1,6}\s/.test(ln)) {
      const dl = DONE_LINE_RE.exec(ln);
      if (dl && !curItem.note) curItem.note = dl[1].trim();
      continue;
    }
    flushPrev();
  }
  flushPrev();
  if (!prevOpen.length) return { changed: false, text: opts.todayMd, added: 0 };

  const have = new Set(extractCheckboxItems(plan.body).map((p) => normKey(p.item)));
  const missing = prevOpen.filter((x) => !have.has(normKey(x.item)));
  if (!missing.length) return { changed: false, text: opts.todayMd, added: 0 };

  const eol = detectEol(opts.todayMd);
  const lines = String(opts.todayMd).split(/\r?\n/);
  const secStart = plan.startLine;
  let secEnd = plan.endLine;
  const blankOrRule = (l) => !String(l).trim() || /^\s*-{3,}\s*$/.test(l);
  while (secEnd - 1 > secStart && blankOrRule(lines[secEnd - 1])) secEnd--;

  function subInsertIndex(title) {
    let head = -1;
    let last = -1;
    for (let i = secStart + 1; i < secEnd; i++) {
      const h = /^###\s+(.+?)\s*$/.exec(lines[i]);
      if (h) {
        if (head >= 0) return last + 1;
        if (h[1] === title) { head = i; last = i; }
        continue;
      }
      if (head >= 0 && String(lines[i]).trim()) last = i;
    }
    return head >= 0 ? last + 1 : -1;
  }

  const bySub = new Map();
  const orphan = [];
  for (const m of missing) {
    const at = m.sub ? subInsertIndex(m.sub) : -1;
    if (at >= 0) {
      if (!bySub.has(m.sub)) bySub.set(m.sub, { at, items: [] });
      bySub.get(m.sub).items.push(m.item);
    } else {
      orphan.push(m.item);
    }
  }

  const inserts = [];
  for (const g of bySub.values()) inserts.push({ at: g.at, items: g.items, wrap: null });
  if (orphan.length) inserts.push({ at: secEnd, items: orphan, wrap: orphanHeading });
  inserts.sort((a, b) => b.at - a.at);

  let added = 0;
  for (const ins of inserts) {
    const block = [];
    if (ins.wrap) block.push(ins.wrap);
    // 目标一行，完成结果留一行空的等你回填
    for (const it of ins.items) {
      block.push('- [ ] ' + mark + ' ' + it);
      block.push(DONE_INDENT + doneLabel);
    }
    lines.splice(ins.at, 0, ...block);
    added += ins.items.length;
  }

  return { changed: true, text: lines.join(eol), added };
}

/* ================================================================ 预设 ==== */

/**
 * 出厂预设：把「日记 → 复盘 / 成长轨迹 / 阅读记录」这套配好。
 * 装上是这个行为，改哪一条都不影响引擎本身。
 */
/**
 * 产物文件的头（只在创建时写一次）。写成模板常量而不是硬编码函数，
 * 这样用户能在设置界面里改，也解释了「为什么产物文件长这样」。
 */
const HEAD_TEMPLATE = [
  '---',
  'date: {{date}}',
  'weekday: {{date:dddd}}',
  'type: {{rule}}',
  'source: "[[{{file}}]]"',
  'tags:',
  '  - {{rule}}',
  '---',
  '',
  '# {{date}} {{rule}}',
  '',
  '> 本文件由 Template Derive 插件维护：`template-derive:start` 与 `template-derive:end` 之间的内容',
  '> 会跟着源文件自动更新，你在标记外面写的东西不会被覆盖。'
].join('\n');

/**
 * 附录（只在创建时写一次，在 auto 标记下方）。
 * ★ 这里存的是「为什么这么设计」的依据，写在产物文件里而不是只放在对话里 ——
 *   几个月后回头看，能立刻知道每一行是谁的结论、要不要改。
 */
const REVIEW_TAIL = [
  '## 我另外想说的',
  '',
  '> [!note]- 这几段为什么长这样（点开看依据）',
  '> **① Feed up / ② Feed back / ④ Feed forward** —— Hattie & Timperley (2007)《The Power of Feedback》',
  '> （*Review of Educational Research*，教育领域被引最多的反馈研究之一）：有效反馈必须回答三个问题 ——',
  '> 我要去哪（Feed up）、我现在走得怎样（Feed back）、下一步去哪（Feed forward）。三个都答，反馈才起作用；',
  '> 只答其中一个（尤其是只夸结果）效果会大打折扣。所以复盘用四行把三问都占了。',
  '>',
  '> **③ 归因只写内部原因** —— Oettingen 的 WOOP / MCII：只写愿望和好处反而会**降低**动机，因为大脑把想象出来的',
  '> 成功误记成「已经达成了」；加入「障碍」这一步才有效。而障碍必须是**内部且可修改**的（方法、情绪、习惯、',
  '> 信念），写成外因只会变成抱怨。Wang et al. (2021) 对 24 项研究的元分析，效果量 g = 0.336。',
  '>',
  '> **④ 里的「如果……就……」** —— Gollwitzer 的实现意图（implementation intention）：94 项研究的元分析，',
  '> d = 0.65。把「什么时候、在哪儿、怎么做」提前决定好，等于把决策从当场的前额叶博弈里挪走 ——',
  '> 这也是「计划常常是前一天定的」为什么真的有用。',
  '>',
  '> **⑤ 今日小胜** —— Amabile & Kramer《The Progress Principle》分析了 11,872 篇工作日日记：好日子里最强的',
  '> 因子就是「在有意义的工作上有进展」，**小胜同样有效**；而且挫折的杀伤力是同量进展的 2–3 倍。',
  '> 所以小胜必须被显式写下来，才抵得住一次卡壳。',
  '>',
  '> **为什么单独存一个文件** —— 源文件是流水，复盘是可检索的记录。分开之后，这个文件夹本身就是一条',
  '> 按日期排好的反思序列。'
].join('\n');

const GROWTH_TAIL = [
  '## 我另外想说的',
  '',
  '> [!note]- 这几段为什么长这样（点开看依据）',
  '> **三格状态（自主 / 胜任 / 联结）** —— Deci & Ryan 的自我决定理论（SDT）：人有三个基本心理需要 ——',
  '> 自主（这件事是我自己选的）、胜任（我确实做得成）、联结（我和人有真实的连接）。',
  '> 任何一格长期被压住，内在动机会掉。每天打分不是为了打分本身，是为了**看到趋势**。',
  '>',
  '> **掌握性证据** —— Bandura (1977) 的自我效能有四个来源，其中**掌握性经验（mastery experience）是最强的',
  '> 一个**，远强于别人的鼓励（social persuasion）。所以要把「我确实做到了什么」写成一条条能拿去复述的证据。',
  '>',
  '> **今日小胜** —— Amabile & Kramer (2011)：哪怕很小的进展，也能撑起一天的动力。',
  '>',
  '> **今天拦住我的** —— 就是 WOOP 里的 Obstacle 一步。障碍必须是**内部的**（情绪 / 行为 / 信念 / 习惯），',
  '> 因为只有内部障碍是你能改的。',
  '>',
  '> **我在成为什么样的人** —— Mueller & Dweck (1998)：被夸「聪明」（person praise）的孩子里 65% 会选择更简单',
  '> 的题，被夸「努力 / 策略」（process praise）的孩子里 90% 会选择更难的题。',
  '> 身份层比结果层更能撑住长期行为，所以这里不记结果，记方向。',
  '>',
  '> **为什么和源文件分开** —— 源文件记「今天发生了什么」，这里记「我正在变成谁」。',
  '> 两条线各自需要连续序列，混在一份文件里会互相淹没。'
].join('\n');

const READING_TAIL = [
  '## 我另外想说的',
  '',
  '> [!note]- 这三段为什么长这样（点开看依据）',
  '> **中间那一段是所有记录里价值最高的一步。** Karpicke & Blunt (2011, *Science*)：读完做自由回忆的人，',
  '> 一周后记住的内容比只读一遍的多 **145%**；而把同一篇读 4 遍的人只多 64%。最有意思的是 ——',
  '> **做测试的人主观上觉得自己学得更少**，因为测试当场暴露了他不会的地方。',
  '> 也就是说，写完这段觉得「怎么这么虚」的时候，恰恰是它起作用的时候。',
  '>',
  '> **为什么这里不叫「总结这一章」。** 总结（summarization）对「理解」有帮助，但对「记住具体事实」不如直接',
  '> 提取；而且总结要好用，必须先经过专门训练，没训练过的总结往往只是抄书。',
  '> 参考：Ophuis-Cox 等（总结 vs 提取的对照实验）；Dunlosky et al. (2013) 把十种学习法全评了一遍，',
  '> 只有提取练习和分散练习评为**高效用**，划重点、重读、总结都是低效用。',
  '>',
  '> **最后一段**来自 Adler & Van Doren《如何阅读一本书》：主动阅读者永远带着四个问题，第四问就是',
  '> 「这本书跟我有什么关系？」后半句沿用 SQ3R 里的 Question，把「下次接着读要先解决什么」提前定好，',
  '> 也就是 Gollwitzer 的实现意图（d = 0.65）。',
  '> Learning Scientists 复盘 SQ3R 的结论是：这套流程里真正被证据支持的是 Recite（提取）和 Review（间隔），',
  '> Survey / Question 证据很弱 —— 所以这份模板只留了证据最硬的部分。',
  '>',
  '> **为什么单独存一个文件** —— 源文件是流水，阅读记录是「我读过什么」的序列，找某一本书的痕迹不用翻日记。'
].join('\n');

const PRESET_RULES = [
  {
    id: 'plan-carry',
    name: '计划结转',
    kind: 'carry',
    enabled: true,
    from: { folder: 'Personal/Diary', dateFormat: 'YYYY-MM-DD' },
    when: { section: '今日计划' },
    carry: { mark: '↺', orphanHeading: '### ↺ 结转自 {{prevDate}}', suffix: DONE_LABEL, maxGapDays: CARRY_MAX_GAP_DAYS }
  },
  {
    id: 'review',
    name: '复盘',
    kind: 'derive',
    enabled: true,
    from: { folder: 'Personal/Diary', dateFormat: 'YYYY-MM-DD' },
    when: { section: '今日复盘', requireContent: true },
    to: {
      path: 'Personal/Review/{{date}}.md',
      template: 'Templates/衍生/复盘.md',
      head: HEAD_TEMPLATE,
      tail: REVIEW_TAIL,
      emptyHint: '> 今天没写复盘。\n>\n> 去源笔记的「今日复盘」段写四行，这里就会自动长出来。'
    }
  },
  {
    id: 'growth',
    name: '成长轨迹',
    kind: 'derive',
    enabled: true,
    from: { folder: 'Personal/Diary', dateFormat: 'YYYY-MM-DD' },
    when: { section: '成长轨迹', requireContent: true, scoreAware: true },
    to: {
      path: 'Personal/Growth Track/{{date}}.md',
      template: 'Templates/衍生/成长轨迹.md',
      head: HEAD_TEMPLATE,
      tail: GROWTH_TAIL,
      emptyHint: '> 今天没填成长轨迹。\n>\n> 去源笔记的「成长轨迹」段打个分，这里就会自动长出来。'
    }
  },
  {
    id: 'reading',
    name: '阅读记录',
    kind: 'derive',
    enabled: true,
    from: { folder: 'Personal/Diary', dateFormat: 'YYYY-MM-DD' },
    when: { section: '今日阅读', requireContent: true },
    to: {
      path: 'Personal/Reading/{{date}}.md',
      template: 'Templates/衍生/阅读记录.md',
      head: HEAD_TEMPLATE,
      tail: READING_TAIL,
      emptyHint: '> 今天没写阅读记录。\n>\n> 去源笔记的「今日阅读」段写三行，这里就会自动长出来。'
    }
  }
];

/** 缺字段的规则补上默认值（用户手写 / 手改 data.json 时会用到）。 */
function normalizeRule(raw) {
  const r = Object.assign({}, raw || {});
  r.id = String(r.id || ('rule-' + Math.random().toString(36).slice(2, 8)));
  r.name = String(r.name || r.id);
  r.kind = r.kind === 'carry' ? 'carry' : 'derive';
  r.enabled = r.enabled !== false;

  const from = Object.assign({}, r.from || {});
  from.folder = normPath(from.folder || '').replace(/\/+$/, '');
  from.dateFormat = from.dateFormat || DEFAULT_DATE_FORMAT;
  r.from = from;

  const when = Object.assign({}, r.when || {});
  when.section = String(when.section || '');
  r.when = when;

  if (r.kind === 'derive') {
    const to = Object.assign({}, r.to || {});
    to.path = String(to.path || '');
    to.template = normPath(to.template || '');
    to.head = to.head == null ? '' : String(to.head);
    to.tail = to.tail == null ? '' : String(to.tail);
    to.emptyHint = to.emptyHint == null ? '' : String(to.emptyHint);
    r.to = to;
  } else {
    const c = Object.assign({}, r.carry || {});
    c.mark = c.mark || '↺';
    c.orphanHeading = c.orphanHeading || ('### ' + c.mark + ' 结转自 {{prevDate}}');
    c.suffix = c.suffix == null ? DONE_LABEL : c.suffix;
    c.maxGapDays = c.maxGapDays > 0 ? c.maxGapDays : CARRY_MAX_GAP_DAYS;
    r.carry = c;
  }
  return r;
}

function normalizeRules(list) {
  return (Array.isArray(list) ? list : []).map(normalizeRule);
}

/** 从旧的 diary-derive data.json 迁移（只有 lastCarry，规则直接落预设）。 */
function migrateState(raw) {
  const s = Object.assign({}, raw || {});
  if (!Array.isArray(s.rules)) {
    s.rules = PRESET_RULES.map((r) => JSON.parse(JSON.stringify(r)));
  }
  s.rules = normalizeRules(s.rules);
  if (typeof s.lastCarry !== 'string') s.lastCarry = '';
  // 输入增强：回车自动补下一条（详见 taskEnterAction）。缺省开。
  if (s.taskEnter === undefined) s.taskEnter = true;
  // 输入增强：学科标题行回车建当天的笔记（详见 subjectEnterAction）。
  // 缺省**关** —— 同一个回车键默认是「补一组 - [ ] / 完成：」，这个更常用；
  // 想要建笔记就在设置里打开，或者用命令「为光标所在学科建今天的笔记」。
  if (s.subjectEnter === undefined) s.subjectEnter = false;
  if (typeof s.subjectRoot !== 'string' || !s.subjectRoot.trim()) s.subjectRoot = SUBJECT_DEFAULT_ROOT;
  if (typeof s.subjectPath !== 'string' || !s.subjectPath.trim()) s.subjectPath = SUBJECT_DEFAULT_PATH;
  if (typeof s.subjectTemplate !== 'string' || !s.subjectTemplate.trim()) s.subjectTemplate = SUBJECT_DEFAULT_TPL;
  // 输入增强：Shift+回车在计划段里再开一个小节（详见 sectionEnterAction）。缺省开。
  if (s.sectionEnter === undefined) s.sectionEnter = true;
  if (!Array.isArray(s.sectionTitles) || !s.sectionTitles.length) s.sectionTitles = SECTION_DEFAULT_TITLES.slice();
  return s;
}

/* ========================================================= 跑一遍规则 ==== */

/**
 * 对单个源文件跑一遍命中的全部规则。
 *
 * io 提供四件事，抽出来之后这套逻辑就能脱离 Obsidian 在 Node 里测：
 *   io.exists(path) -> Promise<bool>
 *   io.read(path)   -> Promise<string>
 *   io.write(path, text) -> Promise<void>   （实现里必须原子写）
 *   io.list(dir)    -> Promise<string[]>    （目录下的文件名，可含子目录）
 *
 * 返回 { actions: [...], state: {...} }，actions 里是每条规则干了什么。
 */
async function runForFile(rules, sourcePath, io, opts) {
  const o = opts || {};
  const state = o.state || {};
  const actions = [];
  const path = normPath(sourcePath);
  const fmt = getRuleDateFormat(rules, path);
  const rawBase = stripExt(baseOf(path));
  const key = keyFromFileName(rawBase, fmt);
  if (!key) return { actions, state };
  // 日期格式写成 `*` 时这里会是空串 —— 那条路线不认识日期，只认文件名。
  const date = dateFromFileName(rawBase, fmt);

  let sourceMd = await io.read(path);
  const hits = matchRules(rules, path);

  // 先跑结转（它改的是源文件本身，后面的渲染要读到结转后的内容）
  for (const rule of hits) {
    if (rule.kind !== 'carry') continue;
    if (o.carry === false) continue;
    if (!o.forceCarry && state.lastCarry === key) continue;

    const prev = o.prevPath;
    if (!prev) { state.lastCarry = key; continue; }
    const prevMd = await io.read(prev);
    const r = carryOver({
      prevMd,
      todayMd: sourceMd,
      prevDate: o.prevDate || '',
      todayDate: date,
      section: rule.when.section,
      mark: rule.carry.mark,
      orphanHeading: rule.carry.orphanHeading,
      suffix: rule.carry.suffix
    });
    if (r.changed) {
      await io.write(path, r.text);
      sourceMd = r.text;
      actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'carried', added: r.added, path });
    } else {
      actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'carry-empty', added: 0, path });
    }
    state.lastCarry = key;
  }

  // 再跑衍生
  for (const rule of hits) {
    if (rule.kind !== 'derive') continue;
    const ctxBase = { rule, file: path, date, sourceMd };
    const parsed = parseSections(sourceMd);
    const sec = getSection(parsed.sections, rule.when.section);
    const ctx = buildCtx(Object.assign({}, ctxBase, { section: sec, sourceMd }));
    const has = !!(sec && substanceCheck(sec.body, rule.when));

    const target = renderPath(rule.to.path, ctx);
    if (!target || target === path) {
      actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'bad-target', path: target });
      continue;
    }

    let tpl = null;
    if (rule.to.template) {
      try { tpl = await io.read(rule.to.template); } catch (e) { tpl = null; }
    }
    if (tpl == null) tpl = '{{section}}';

    // ★ 没写就绝不新建文件 —— 这是这个插件的核心承诺，emptyHint 也不能破例。
    //   emptyHint 的用武之地只有一处：文件已经存在、源段落后来被清空了，用它换掉标记区里的旧内容。
    //   规则没配 emptyHint 时 inner 为 null，表示「什么都不做」，不拿空串去覆盖。
    const inner = has
      ? renderTemplate(tpl, ctx)
      : (rule.to.emptyHint ? renderTemplate(rule.to.emptyHint, ctx) : null);

    const exists = await io.exists(target);
    if (!exists) {
      if (!has) {
        actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'skipped', path: target });
        continue;
      }
      await io.write(target, wrapNew(renderTemplate(rule.to.head || '', ctx), inner, renderTemplate(rule.to.tail || '', ctx)));
      actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'created', path: target });
      continue;
    }

    const old = await io.read(target);
    if (!hasAutoBlock(old)) {
      actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'foreign', path: target });
      continue;
    }
    if (inner == null) {
      actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'unchanged', path: target });
      continue;
    }
    const next = upsertAutoBlock(old, inner);
    if (next === old) {
      actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'unchanged', path: target });
      continue;
    }
    await io.write(target, next);
    actions.push({ ruleId: rule.id, ruleName: rule.name, result: 'updated', path: target });
  }

  return { actions, state };
}

function getRuleDateFormat(rules, filePath) {
  for (const r of (rules || [])) {
    if (fileMatchesRule(r, filePath)) return (r.from && r.from.dateFormat) || DEFAULT_DATE_FORMAT;
  }
  return DEFAULT_DATE_FORMAT;
}

/** 找源文件的上一个兄弟文件（按日期倒着找，超过 maxGapDays 就当断了）。 */
function pickPrevious(dates, date, maxGapDays) {
  const earlier = (dates || []).filter((d) => d && d < date).sort();
  if (!earlier.length) return '';
  const last = earlier[earlier.length - 1];
  if (daysBetween(last, date) > (maxGapDays > 0 ? maxGapDays : CARRY_MAX_GAP_DAYS)) return '';
  return last;
}

/* ------------------------------------------------------------- 导出 ---- */

const PURE = {
  AUTO_START, AUTO_END, LEGACY_PAIRS, DEFAULT_DATE_FORMAT, MIN_SUBSTANCE,
  DEBOUNCE_MS, CARRY_MAX_GAP_DAYS, PRESET_RULES, VAR_RE,
  HEAD_TEMPLATE, REVIEW_TAIL, GROWTH_TAIL, READING_TAIL,
  pad2, weekdayCN, daysBetween, shiftDate, formatDate, namePatternToRe, dateFromFileName, keyFromFileName,
  renderDailyNoteVars,
  detectEol, normPath, dirOf, baseOf, stripExt,
  parseSections, getSection, subSectionBody, groupBySubSection, frontmatterValue,
  stripCallouts, cleanForSubstance, cleanLen, digitLen, hasSubstance, hasSubstanceOrScore,
  substanceCheck, extractLabeledBullets, pickValue, extractScores,
  extractCheckboxItems, extractCheckboxLines, checkboxLinesToMd, normKey,
  DONE_INDENT, DONE_LABEL, DONE_FIELD_RE, DONE_LINE_RE, CHECKBOX_LINE_RE,
  isDoneLine, nearestItem, taskEnterAction,
  SUBJECT_DEFAULT_ROOT, SUBJECT_DEFAULT_PATH, SUBJECT_DEFAULT_TPL,
  renderSubjectVars, normTarget, hasLinkTo, subjectEnterAction,
  SECTION_DEFAULT_TITLES, sectionEnterAction,
  buildCtx, evalVar, renderTemplate, renderPath, fieldValue, linesValue, scoreValue, checksValue, contentOf,
  findAutoBlock, hasAutoBlock, upsertAutoBlock, wrapNew,
  isUnder, fileMatchesRule, matchRules, carryOver,
  normalizeRule, normalizeRules, migrateState, runForFile,
  getRuleDateFormat, pickPrevious
};

/* ============================================================== 插件壳 ==== */

if (obsidianApi) {
  const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView } = obsidianApi;

  /**
   * 学科笔记的兜底模板：`Templates/学科笔记模板.md` 不存在时用它。
   * 只有 {{course}} / {{date}} / {{weekday}} / {{diary}} 四个变量（见 renderSubjectVars）。
   */
  const SUBJECT_FALLBACK_TPL = [
    '---',
    'title: {{course}} · {{date:YYYY-MM-DD}}',
    'course: {{course}}',
    'date: {{date:YYYY-MM-DD}}',
    'tags:',
    '  - 课堂笔记',
    '---',
    '',
    '## 今天这节课在讲什么',
    '',
    '## 没听懂 / 要回头补的',
    '',
    '## 课后要做（下次课前解决）',
    '',
    '---',
    '当天日记：{{diary}}',
    ''
  ].join('\n');

  const RESULT_TEXT = {
    created: '生成',
    updated: '更新',
    unchanged: '',
    skipped: '',
    none: '',
    foreign: '跳过（文件里没有 auto 标记，判定是你手建的）',
    'bad-target': '跳过（产物路径和源文件是同一个）',
    carried: '结转',
    'carry-empty': ''
  };

  class TemplateDerivePlugin extends Plugin {
    async onload() {
      this.settings = migrateState(await this.loadData());
      await this.saveData(this.settings);

      this._timer = null;
      this._busy = false;
      this._again = null;
      this._suppress = new Set();

      const handler = (file) => {
        const p = file && file.path;
        if (!p) return;
        if (this._suppress.has(normPath(p))) return;
        if (!matchRules(this.settings.rules, p).length) return;
        this._schedule(p);
      };
      this.registerEvent(this.app.vault.on('create', handler));
      this.registerEvent(this.app.vault.on('modify', handler));

      this.addCommand({
        id: 'template-derive-sync-current',
        name: '为当前笔记生成 / 更新衍生文件',
        checkCallback: (checking) => {
          const f = this.app.workspace.getActiveFile();
          if (!f || !matchRules(this.settings.rules, f.path).length) return false;
          if (!checking) this._run(f.path, { notify: true, carry: true });
          return true;
        }
      });
      this.addCommand({
        id: 'template-derive-sync-today',
        name: '处理今天的所有源文件',
        callback: () => this._runToday({ notify: true, carry: true })
      });
      this.addCommand({
        id: 'template-derive-force-carry',
        name: '把上一天没做完的条目结转到今天（忽略去重）',
        callback: () => this._runToday({ notify: true, carry: true, forceCarry: true })
      });
      this.addCommand({
        id: 'template-derive-subject-note',
        name: '为光标所在学科建今天的笔记',
        callback: () => this._subjectFromCommand()
      });
      // 核心 Daily Notes 只会建「今天」这一份，想去明天/后天就用这个。
      this.addCommand({
        id: 'template-derive-new-diary',
        name: '新建明天的日记',
        callback: () => this._newDiaryNote(1)
      });
      // Calendar 插件注册了日历视图，可它自己那条命令是英文的（Calendar: Open view），
      // 而且**只在日历还没打开时才显示** —— 已经开着的话命令直接消失，找不着人。
      // 这里补一条中文的，不管日历开着没有都看得见。
      this.addCommand({
        id: 'template-derive-open-calendar',
        name: '打开日历视图',
        checkCallback: (checking) => {
          if (!this._calendarAvailable()) return false;
          if (checking) return true;
          this._openCalendar();
          return true;
        }
      });
      // 键盘那条路万一不灵，这个命令做一模一样的事 —— 顺便能用来确认插件确实更新了。
      this.addCommand({
        id: 'template-derive-add-section',
        name: '在计划里新增一个小节（### + 待办）',
        callback: () => this._addSection()
      });

      this.addSettingTab(new TemplateDeriveSettingTab(this.app, this));

      // 回车续行：捕获阶段先手拦下回车，自己插内容（详见 taskEnterAction 上面那段注释）。
      // 用捕获 + stopPropagation 是为了不让 CodeMirror 再处理一遍，否则会插入两次。
      this.registerDomEvent(document, 'keydown', (e) => this._onTaskEnter(e), true);

      // 启动后补跑一次：用户可能是关着 Obsidian 改的日记。
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => this._runToday({ notify: false, carry: true }), 2500);
      });
    }

    onunload() {
      if (this._timer) window.clearTimeout(this._timer);
    }

    /**
     * 两种回车。都只在「有规则管着的文件」里动手 —— 别的笔记一个键都不碰。
     * 命中就 preventDefault + stopPropagation 自己插；不命中就原样放行。
     *
     *   Shift+回车 → 在计划段里**再开一个小节**（### + 一组空占位），见 sectionEnterAction
     *   普通回车   → 补「完成：」那一行 / 补一组空占位，见 taskEnterAction
     */
    _onTaskEnter(e) {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (!t || typeof t.closest !== 'function' || !t.closest('.cm-content')) return;

      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.file || !view.editor) return;
      const editor = view.editor;
      if (typeof editor.getLine !== 'function' || typeof editor.replaceRange !== 'function') return;

      const rules = matchRules(this.settings.rules, view.file.path);
      if (!rules.length) return;
      const carry = rules.find((r) => r.kind === 'carry' && r.carry && r.carry.suffix);
      const label = (carry && carry.carry.suffix) || DONE_LABEL;

      const pos = editor.getCursor();
      if (!pos || pos.line == null) return;
      const n = editor.lineCount();
      const getLine = (i) => (i < 0 || i >= n ? null : editor.getLine(i));

      // Shift+回车：整个小节连骨架一起给。和下面的普通回车是两条独立的路。
      if (e.shiftKey) {
        if (this.settings.sectionEnter === false) return;
        const sec = sectionEnterAction(getLine, pos.line, { titles: this.settings.sectionTitles, label });
        if (!sec) return;
        e.preventDefault();
        e.stopPropagation();
        const secAt = getLine(sec.line);
        editor.replaceRange(sec.text, { line: sec.line, ch: secAt == null ? 0 : secAt.length });
        editor.setCursor({
          line: sec.line + (sec.text.match(/\n/g) || []).length - sec.cursor.back,
          ch: sec.cursor.ch
        });
        return;
      }

      if (this.settings.taskEnter === false) return;

      // ★ 顺序有讲究：两个功能都要「### 行尾的回车」，必须先让学科那个看一眼。
      //   它开着、并且这一行确实是学科 → 建笔记；否则（包括它关着、或者
      //   这行是「### 阅读」这种不是学科的）才轮到 taskEnterAction，
      //   由它按老规矩补一组「- [ ] / 完成：」。
      if (this.settings.subjectEnter === true) {
        const subj = subjectEnterAction(getLine, pos.line, pos.ch,
          (t) => this._resolveSubject(t),
          { path: this.settings.subjectPath, date: this._today(), diary: view.file.path });
        if (subj) {
          this._subjectEnter(e, editor, view, pos, subj);
          return;
        }
      }

      const act = taskEnterAction(getLine, pos.line, { label, ch: pos.ch });
      if (!act) return;

      e.preventDefault();
      e.stopPropagation();

      if (act.mode === 'cursor') {
        editor.setCursor({ line: act.line, ch: act.ch });
        return;
      }
      const at = editor.getLine(act.line);
      const back = (act.cursor && act.cursor.back) || 0;
      editor.replaceRange(act.text, { line: act.line, ch: at == null ? 0 : at.length });
      editor.setCursor({
        line: act.line + (act.text.match(/\n/g) || []).length - back,
        ch: act.cursor.ch
      });
    }

    /**
     * 学科标题行回车：建这门课今天的笔记 → 日记里留一个链接 → 跳过去写。
     * 命中才吃掉这次回车；不命中一个字都不动（见 subjectEnterAction 里的四种放行）。
     * e 为 null 表示是命令触发的，没有键盘事件要拦。
     */
    async _subjectEnter(e, editor, view, pos, act) {
      if (!act) return;
      try {
        if (e) { e.preventDefault(); e.stopPropagation(); }

        const link = stripExt(act.path);
        if (!act.linked) {
          const at = getLine(pos.line);
          editor.replaceRange('\n- [[' + link + ']]', { line: pos.line, ch: at == null ? 0 : at.length });
        }
        const made = await this._ensureSubjectFile(act, view.file.path);
        if (made) new Notice('Template Derive：建了 ' + act.path);
        // 同一个文件再按一次不会重复建，也不会重复插链接，只是再打开一次。
        await this.app.workspace.openLinkText(link, view.file.path, false);
      } catch (err) {
        console.error('[template-derive] 学科回车出错', err);
        new Notice('Template Derive 建笔记失败了，详见控制台');
      }
    }

    /** 命令版：从光标往上找最近的学科小标题，干和回车一样的事。 */
    async _subjectFromCommand() {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.file || !view.editor) {
        new Notice('Template Derive：先在日记里点一下');
        return;
      }
      const editor = view.editor;
      const n = editor.lineCount();
      const getLine = (i) => (i < 0 || i >= n ? null : editor.getLine(i));
      const pos = editor.getCursor();
      const from = pos && pos.line != null ? pos.line : 0;
      for (let i = from; i >= 0 && i > from - 60; i--) {
        const act = subjectEnterAction(getLine, i, null, (t) => this._resolveSubject(t),
          { path: this.settings.subjectPath, date: this._today(), diary: view.file.path });
        if (act) {
          await this._subjectEnter(null, editor, view, { line: i, ch: 0 }, act);
          return;
        }
      }
      new Notice('Template Derive：光标往上没找到学科小标题');
    }

    /** 命令版「新增一个小节」：和 Shift+回车干同一件事。 */
    _addSection() {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.file || !view.editor) {
        new Notice('Template Derive：先在日记里点一下');
        return;
      }
      const editor = view.editor;
      const n = editor.lineCount();
      const getLine = (i) => (i < 0 || i >= n ? null : editor.getLine(i));
      const pos = editor.getCursor();
      const rules = matchRules(this.settings.rules, view.file.path);
      const carry = rules.find((r) => r.kind === 'carry' && r.carry && r.carry.suffix);
      const label = (carry && carry.carry.suffix) || DONE_LABEL;
      const act = sectionEnterAction(getLine, pos && pos.line != null ? pos.line : 0, {
        titles: this.settings.sectionTitles, label: label
      });
      if (!act) {
        new Notice('Template Derive：光标不在「' + (this.settings.sectionTitles || []).join(' / ') + '」这一段里');
        return;
      }
      const at = getLine(act.line);
      editor.replaceRange(act.text, { line: act.line, ch: at == null ? 0 : at.length });
      editor.setCursor({
        line: act.line + (act.text.match(/\n/g) || []).length - act.cursor.back,
        ch: act.cursor.ch
      });
    }

    /** 标题文字 → Subjects/ 下真有这个文件夹才认。对不上返回 null（那就不是学科）。 */
    _resolveSubject(title) {
      const root = normPath(this.settings.subjectRoot || SUBJECT_DEFAULT_ROOT).replace(/\/+$/, '');
      if (!root || !title) return null;
      if (this.app.vault.getAbstractFileByPath(root + '/' + title)) return title;
      return null;
    }

    /** 文件不在就按模板建一个；**在就什么都不做** —— 绝不覆盖你已经写过的内容。 */
    async _ensureSubjectFile(act, sourcePath) {
      const key = normPath(act.path);
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(key)) return false;
      let body = SUBJECT_FALLBACK_TPL;
      const tpl = normPath(this.settings.subjectTemplate || SUBJECT_DEFAULT_TPL);
      if (tpl && await adapter.exists(tpl)) body = await adapter.read(tpl);
      await this._write(key, renderSubjectVars(body, {
        name: act.name, date: this._today(), diary: sourcePath
      }));
      return true;
    }

    async saveSettings() {
      await this.saveData(this.settings);
    }

    _today() {
      const d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    /**
     * Calendar 插件有没有装并且启用。没开就干脆不显示「打开日历」这条命令 ——
     * 宁可看不见，也别让人点了以后弹一串看不懂的报错。
     */
    _calendarAvailable() {
      try {
        const ps = this.app.plugins;
        if (!ps) return false;
        if (ps.enabledPlugins && typeof ps.enabledPlugins.has === 'function') {
          return ps.enabledPlugins.has('calendar');
        }
        return !!(ps.plugins && ps.plugins.calendar);
      } catch (e) {
        return false;
      }
    }

    /** 打开日历视图：已经开着就把它叫到前台，没开就放到右侧栏里。 */
    async _openCalendar() {
      const ws = this.app.workspace;
      try {
        const opened = ws.getLeavesOfType ? ws.getLeavesOfType('calendar') : [];
        if (opened && opened.length) {
          if (ws.revealLeaf) ws.revealLeaf(opened[0]);
          return true;
        }
        const leaf = ws.getRightLeaf ? ws.getRightLeaf(false) : null;
        const target = leaf || (ws.getLeaf ? ws.getLeaf(true) : null);
        if (!target) return false;
        await target.setViewState({ type: 'calendar', active: true });
        if (ws.revealLeaf) ws.revealLeaf(target);
        return true;
      } catch (e) {
        new Notice('Template Derive：日历没打开 —— ' + ((e && e.message) || e));
        return false;
      }
    }

    /**
     * 核心 Daily Notes 的三件套：日记放哪儿、文件名什么格式、用哪份模板。
     * 直接读核心插件自己的配置文件 —— 用户在设置里改了这里跟着变，不用再来改一遍。
     * 读不到（比如核心 Daily Notes 压根没启用）就用内定的那组。
     */
    async _dailyNotesConfig() {
      const cfg = {
        folder: 'Personal/Diary',
        format: 'YYYY-MM-DD',
        template: 'Templates/日记模板.md'
      };
      try {
        const j = JSON.parse(await this.app.vault.adapter.read('.obsidian/daily-notes.json'));
        if (typeof j.folder === 'string' && j.folder.trim()) cfg.folder = normPath(j.folder.trim());
        if (typeof j.format === 'string' && j.format.trim()) cfg.format = j.format.trim();
        if (typeof j.template === 'string' && j.template.trim()) cfg.template = normPath(j.template.trim());
      } catch (e) { /* 没启用核心 Daily Notes，用内定值 */ }
      return cfg;
    }

    /**
     * 新建某一天的日记，`days` 交给 shiftDate（传 1 就是明天）。
     *
     * 核心插件只给了一个「打开今天的日记」，想去明天只能手建 —— 手建最容易错的是
     * 文件名格式和 frontmatter 里的日期，一步错这份日记就脱出整套体系：
     * 按日期命名的规则认不出它，结转也不会来找它。所以这里照抄核心的配置来建。
     *
     * ★ 文件已经存在 → 只打开，**绝不动里面一个字**。
     */
    async _newDiaryNote(days) {
      const cfg = await this._dailyNotesConfig();
      const target = shiftDate(this._today(), days);
      if (!target) return false;

      const name = formatDate(target, cfg.format);
      const path = normPath((cfg.folder ? cfg.folder.replace(/\/+$/, '') + '/' : '') + name + '.md');
      const app = this.app;

      // 已经写过了 → 打开它
      const exist = app.vault.getAbstractFileByPath(path);
      if (exist) {
        await app.workspace.getLeaf(false).openFile(exist);
        new Notice('Template Derive：' + target + ' 的日记已经有了，直接打开');
        return true;
      }

      // 目录可能还不存在（第一次用），先补上
      const slash = path.lastIndexOf('/');
      const dir = slash > 0 ? path.slice(0, slash) : '';
      try {
        if (dir && !(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
      } catch (e) { /* 已经建过了就算了 */ }

      let body = '';
      try {
        const adapter = app.vault.adapter;
        if (cfg.template && await adapter.exists(cfg.template)) body = await adapter.read(cfg.template);
      } catch (e) { /* 模板不存在就建个空的，不算错 */ }

      const now = new Date();
      const content = renderDailyNoteVars(body, {
        date: target,
        time: pad2(now.getHours()) + ':' + pad2(now.getMinutes()),
        title: name
      });

      const file = await app.vault.create(path, content);
      await app.workspace.getLeaf(false).openFile(file);
      new Notice('Template Derive：' + target + ' 的日记好了');
      return true;
    }

    /** 按规则的日期格式推出「今天」的源文件名。文件名任意（`*`）的规则推不出来，跳过。 */
    _todayPathFor(rule) {
      const fmt = (rule.from && rule.from.dateFormat) || DEFAULT_DATE_FORMAT;
      if (fmt === '*') return '';
      const name = formatDate(this._today(), fmt);
      const folder = (rule.from && rule.from.folder) || '';
      return (folder ? folder.replace(/\/+$/, '') + '/' : '') + name + '.md';
    }

    async _runToday(opts) {
      const adapter = this.app.vault.adapter;
      const seen = new Set();
      for (const rule of this.settings.rules) {
        if (rule.enabled === false) continue;
        const p = this._todayPathFor(rule);
        if (!p || seen.has(p)) continue;
        seen.add(p);
        try {
          if (await adapter.exists(p)) await this._run(p, opts);
        } catch (e) { /* 单个源文件出错不影响其它规则 */ }
      }
      if (opts && opts.notify) new Notice('Template Derive：今天的源文件都处理过了');
    }

    _schedule(vaultPath) {
      this._pending = vaultPath;
      if (this._timer) window.clearTimeout(this._timer);
      this._timer = window.setTimeout(() => {
        this._timer = null;
        this._run(this._pending, { notify: false, carry: true });
      }, DEBOUNCE_MS);
    }

    _makeIo() {
      const adapter = this.app.vault.adapter;
      const self = this;
      return {
        exists: (p) => adapter.exists(p),
        read: (p) => adapter.read(p),
        write: (p, text) => self._write(p, text),
        list: async (dir) => {
          try {
            const r = await adapter.list(dir);
            return (r && r.files) || [];
          } catch (e) { return []; }
        }
      };
    }

    /** 找同一源文件夹里、日期在 target 之前的上一个源文件。 */
    async _findPrev(sourcePath, rules) {
      const folder = dirOf(sourcePath);
      const rule = (rules || []).find((r) => r.kind === 'carry' && isUnder(folder, r.from.folder));
      const fmt = (rule && rule.from.dateFormat) || DEFAULT_DATE_FORMAT;
      // 文件名任意（`*`）就没有「上一天」这个概念，结转不适用。
      if (fmt === '*') return null;
      const maxGap = (rule && rule.carry && rule.carry.maxGapDays) || CARRY_MAX_GAP_DAYS;
      let files = [];
      try {
        const r = await this.app.vault.adapter.list(folder);
        files = (r && r.files) || [];
      } catch (e) { return null; }
      const date = dateFromFileName(stripExt(baseOf(sourcePath)), fmt);
      const dates = files.map((p) => dateFromFileName(stripExt(baseOf(p)), fmt)).filter(Boolean);
      const prev = pickPrevious(dates, date, maxGap);
      if (!prev) return null;
      return { path: folder + '/' + formatDate(prev, fmt) + '.md', date: prev };
    }

    async _run(sourcePath, opts) {
      const o = opts || {};
      if (this._busy) { this._again = { sourcePath, opts: o }; return; }
      this._busy = true;
      const said = [];
      try {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(sourcePath))) return;

        const rules = this.settings.rules;
        const prev = o.carry === false ? null : await this._findPrev(sourcePath, rules);
        const res = await runForFile(rules, sourcePath, this._makeIo(), {
          state: this.settings,
          carry: o.carry,
          forceCarry: o.forceCarry,
          prevPath: prev ? prev.path : null,
          prevDate: prev ? prev.date : ''
        });
        await this.saveData(this.settings);

        for (const a of res.actions) {
          const t = RESULT_TEXT[a.result];
          if (!t) continue;
          if (a.result === 'carried') said.push('结转了 ' + a.added + ' 条没做完的条目');
          else if (a.result === 'foreign' || a.result === 'bad-target') said.push(a.ruleName + '：' + t);
          else said.push(t + '了' + a.ruleName);
        }

        if (o.notify) {
          new Notice(said.length ? 'Template Derive：' + said.join('，') : 'Template Derive：已经是最新的了');
        }
      } catch (err) {
        console.error('[template-derive]', err);
        if (o.notify) new Notice('Template Derive 出错了，详见控制台');
      } finally {
        this._busy = false;
        if (this._again) {
          const nxt = this._again;
          this._again = null;
          this._run(nxt.sourcePath, nxt.opts);
        }
      }
    }

    /**
     * 原子写入：临时文件 + rename。
     * 直接覆盖会被文件监听器读到「写了一半」的中间态 —— 真事故，见文件头注释。
     * fs 不可用时（移动端）退回 adapter 写入。
     */
    async _write(vaultPath, content) {
      const adapter = this.app.vault.adapter;
      const key = normPath(vaultPath);
      this._suppress.add(key);
      window.setTimeout(() => this._suppress.delete(key), 4000);

      const base = (typeof adapter.getBasePath === 'function') ? adapter.getBasePath() : null;
      if (base && fsMod && pathMod) {
        const abs = pathMod.join(base, ...key.split('/'));
        const dir = pathMod.dirname(abs);
        await fsMod.promises.mkdir(dir, { recursive: true });
        const tmp = pathMod.join(dir, '.' + pathMod.basename(abs) + '.wbtmp');
        await fsMod.promises.writeFile(tmp, content, 'utf8');
        await fsMod.promises.rename(tmp, abs);
        return;
      }
      const dir = dirOf(key);
      if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(key, content);
    }
  }

  /* --------------------------------------------------------- 设置界面 ---- */

  const KIND_LABEL = { derive: '衍生文件', carry: '结转复选框' };

  class TemplateDeriveSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
      super(app, plugin);
      this.plugin = plugin;
    }

    // eslint-disable-next-line max-lines-per-function
    display() {
      const c = this.containerEl;
      c.empty();
      const p = this.plugin;

      c.createEl('h2', { text: 'Template Derive' });
      c.createEl('p', {
        cls: 'setting-item-description',
        text: '一条规则 = 「哪个文件夹里的哪个段落 → 渲染到哪个文件」。段落里写了东西就生成 / 更新产物，没写就不生成。规则只动 auto 标记之间的区域，标记外面你手写的内容永远不会被覆盖。'
      });

      const top = new Setting(c);
      top.addButton((b) => b.setButtonText('新增规则').setCta().onClick(async () => {
        p.settings.rules.push(normalizeRule({
          id: 'rule-' + Date.now().toString(36),
          name: '新规则',
          kind: 'derive',
          from: { folder: '', dateFormat: DEFAULT_DATE_FORMAT },
          when: { section: '' },
          to: { path: '', template: '', head: '# {{date}}', emptyHint: '' }
        }));
        await p.saveSettings();
        this.display();
      }));
      top.addButton((b) => b.setButtonText('恢复出厂预设').onClick(async () => {
        p.settings.rules = normalizeRules(JSON.parse(JSON.stringify(PRESET_RULES)));
        await p.saveSettings();
        this.display();
        new Notice('已恢复为出厂预设（日记 → 复盘 / 成长轨迹 / 阅读记录）');
      }));
      top.addButton((b) => b.setButtonText('处理今天').onClick(() => p._runToday({ notify: true, carry: true })));

      p.settings.rules.forEach((rule, idx) => this.renderRule(c, rule, idx));

      const enh = c.createEl('details', { cls: 'template-derive-enhance' });
      enh.createEl('summary', { text: '输入增强' });
      new Setting(enh)
        .setName('回车自动补下一条')
        .setDesc('在上述规则管的文件里：在「- [ ] 目标」那一行按回车，自动补出下面缩进的「完成：」行；'
          + '在「完成：」行按回车，自动开始下一条；'
          + '在「### 小标题」行**末尾**按回车，直接给一组「- [ ] / 完成：」，光标停在方框后面。'
          + '下面已经有空占位就直接把光标送过去，不重复插。'
          + '想单纯换行按 Alt+回车（Shift+回车另有用途，见下一条）。')
        .addToggle((t) => t.setValue(p.settings.taskEnter !== false).onChange(async (v) => {
          p.settings.taskEnter = v;
          await p.saveSettings();
        }));

      new Setting(enh)
        .setName('Shift+回车 → 在计划里再开一个小节')
        .setDesc('在「' + (p.settings.sectionTitles || []).join(' / ') + '」这一段里按 Shift+回车：'
          + '在光标所在小节的后面插一整个新小节 —— `###` 加一组「- [ ] / 完成：」，'
          + '光标停在 `###` 后面等着打学科名。其它段落一个字都不动。'
          + '键盘这条路万一不灵，命令面板里「在计划里新增一个小节（### + 待办）」做一模一样的事。')
        .addToggle((t) => t.setValue(p.settings.sectionEnter !== false).onChange(async (v) => {
          p.settings.sectionEnter = v;
          await p.saveSettings();
        }));
      new Setting(enh)
        .setName('允许开小节的段落')
        .setDesc('`##` 段落标题，多个用逗号隔开。')
        .addText((t) => t.setValue((p.settings.sectionTitles || []).join('，')).onChange(async (v) => {
          const arr = String(v || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
          p.settings.sectionTitles = arr.length ? arr : SECTION_DEFAULT_TITLES.slice();
          await p.saveSettings();
        }));

      new Setting(enh)
        .setName('学科标题行回车 → 建当天的笔记（默认关）')
        .setDesc('打开后，「### 学科名」行尾按回车改成**建笔记**：按下面的路径模板建出这门课今天的笔记，'
          + '在这一行下面留一个 [[链接]]，然后跳过去写。文件已经存在就只打开、绝不覆盖。'
          + '只有学科文件夹里有同名文件夹的标题才认 —— 「### 阅读」「### 锻炼」这类天然不命中。'
          + '**不打开这个开关时，那一次回车用来补一组「- [ ] / 完成：」。**'
          + '两种情况下想单纯换行都按 Shift+回车。')
        .addToggle((t) => t.setValue(p.settings.subjectEnter !== false).onChange(async (v) => {
          p.settings.subjectEnter = v;
          await p.saveSettings();
        }));
      new Setting(enh)
        .setName('学科文件夹')
        .setDesc('判定「这个标题是不是一门课」的根目录。')
        .addText((t) => t.setValue(p.settings.subjectRoot).onChange(async (v) => {
          p.settings.subjectRoot = v.trim() || SUBJECT_DEFAULT_ROOT;
          await p.saveSettings();
        }));
      new Setting(enh)
        .setName('笔记路径模板')
        .setDesc('可用 {{name}}（学科文件夹名）、{{date:YYYY-MM-DD}}、{{weekday}}。')
        .addText((t) => t.setValue(p.settings.subjectPath).onChange(async (v) => {
          p.settings.subjectPath = v.trim() || SUBJECT_DEFAULT_PATH;
          await p.saveSettings();
        }));
      new Setting(enh)
        .setName('笔记模板文件')
        .setDesc('库内可编辑；留空或文件不存在就用插件内置的简易模板。'
          + '可用 {{course}} {{date:YYYY-MM-DD}} {{weekday}} {{diary}}（指回当天日记）。')
        .addText((t) => t.setValue(p.settings.subjectTemplate).onChange(async (v) => {
          p.settings.subjectTemplate = v.trim() || SUBJECT_DEFAULT_TPL;
          await p.saveSettings();
        }));

      const adv = c.createEl('details');
      adv.createEl('summary', { text: '规则 JSON（在这里复制出来分享，或粘回去导入）' });
      const ta = adv.createEl('textarea', { cls: 'template-derive-json' });
      ta.style.width = '100%';
      ta.style.height = '220px';
      ta.style.fontFamily = 'var(--font-monospace)';
      ta.style.fontSize = '12px';
      ta.value = JSON.stringify(p.settings.rules, null, 2);
      new Setting(adv).addButton((b) => b.setButtonText('应用这段 JSON').onClick(async () => {
        try {
          const parsed = JSON.parse(ta.value);
          if (!Array.isArray(parsed)) throw new Error('顶层必须是数组');
          p.settings.rules = normalizeRules(parsed);
          await p.saveSettings();
          this.display();
          new Notice('已导入 ' + p.settings.rules.length + ' 条规则');
        } catch (e) {
          new Notice('JSON 有问题：' + e.message);
        }
      }));
    }

    renderRule(c, rule, idx) {
      const p = this.plugin;
      const box = c.createEl('details', { cls: 'template-derive-rule' });
      box.open = true;
      const sum = box.createEl('summary');
      sum.createSpan({ text: (idx + 1) + ' · ' + rule.name });
      sum.createSpan({ cls: 'setting-item-description', text: '　' + (KIND_LABEL[rule.kind] || rule.kind) });

      const save = async (rerender) => {
        await p.saveSettings();
        if (rerender) this.display();
      };

      new Setting(box)
        .setName('启用')
        .setDesc('关掉之后这条规则不参与任何处理。')
        .addToggle((t) => t.setValue(rule.enabled !== false).onChange(async (v) => {
          rule.enabled = v;
          await save(false);
        }));

      new Setting(box)
        .setName('规则名')
        .setDesc('用来在产物文件头显示（模板里的 {{rule}}），也是命令提示里的名字。')
        .addText((t) => t.setValue(rule.name).onChange(async (v) => {
          rule.name = v;
          sum.firstChild.textContent = (idx + 1) + ' · ' + v;
          await save(false);
        }));

      new Setting(box)
        .setName('类型')
        .setDesc('「衍生文件」= 把段落渲染成新文件；「结转复选框」= 把上一个源文件里没做完的复选框搬进今天的源文件。')
        .addDropdown((d) => {
          d.addOption('derive', KIND_LABEL.derive);
          d.addOption('carry', KIND_LABEL.carry);
          d.setValue(rule.kind);
          d.onChange(async (v) => {
            rule.kind = v === 'carry' ? 'carry' : 'derive';
            await p.saveSettings();
            this.display();
          });
        });

      new Setting(box)
        .setName('源文件夹')
        .setDesc('只监听这个文件夹（含子文件夹）里的笔记。留空 = 全库。')
        .addText((t) => t.setPlaceholder('Personal/Diary')
          .setValue(rule.from.folder)
          .onChange(async (v) => { rule.from.folder = normPath(v.trim()).replace(/\/+$/, ''); await save(false); }));

      new Setting(box)
        .setName('文件名日期格式')
        .setDesc('源文件名长什么样。YYYY / MM / DD 是占位符，其它字符原样匹配（如 YYYY年MM月DD日）。写成 * 表示文件名任意、不认日期 —— 这时用 {{name}} / {{key}} 取文件名。')
        .addText((t) => t.setPlaceholder('YYYY-MM-DD')
          .setValue(rule.from.dateFormat)
          .onChange(async (v) => { rule.from.dateFormat = v.trim() || DEFAULT_DATE_FORMAT; await save(false); }));

      new Setting(box)
        .setName('触发段落')
        .setDesc('源文件里的二级标题（不含 ##）。先精确匹配，再退化成「包含」。')
        .addText((t) => t.setPlaceholder('今日复盘')
          .setValue(rule.when.section)
          .onChange(async (v) => { rule.when.section = v.trim(); await save(false); }));

      if (rule.kind === 'derive') {
        new Setting(box)
          .setName('写了才创建')
          .setDesc('关掉就是「总是创建」，段落空着也会生成产物（用空提示占位）。')
          .addToggle((t) => t.setValue(rule.when.requireContent !== false).onChange(async (v) => {
            rule.when.requireContent = v;
            await save(false);
          }));

        new Setting(box)
          .setName('打分也算写了')
          .setDesc('光打「精力：4 / 5」这种分数、没写别的字，也算写了。')
          .addToggle((t) => t.setValue(!!rule.when.scoreAware).onChange(async (v) => {
            rule.when.scoreAware = v;
            await save(false);
          }));

        new Setting(box)
          .setName('产物路径')
          .setDesc('支持变量，例如 Personal/Review/{{date}}.md。')
          .addText((t) => t.setPlaceholder('Personal/Review/{{date}}.md')
            .setValue(rule.to.path)
            .onChange(async (v) => { rule.to.path = v.trim(); await save(false); }));

        const tplSetting = new Setting(box)
          .setName('输出模板文件')
          .setDesc('库里的一份 Markdown，里面的变量会被替换。取不到就退回「原样搬段落」。');
        tplSetting.addText((t) => t.setPlaceholder('Templates/衍生/复盘.md')
          .setValue(rule.to.template)
          .onChange(async (v) => { rule.to.template = normPath(v.trim()); await save(false); }));
        tplSetting.addExtraButton((b) => b.setIcon('pencil').setTooltip('在库里打开这个文件').onClick(async () => {
          if (!rule.to.template) { new Notice('还没填模板文件路径'); return; }
          const f = this.app.vault.getAbstractFileByPath(rule.to.template);
          if (!f) { new Notice('找不到这个文件：' + rule.to.template); return; }
          await this.app.workspace.openLinkText(rule.to.template, '', false);
        }));

        new Setting(box)
          .setName('文件头（只在创建时写一次）')
          .setDesc('在 auto 标记上方，之后不再改动。支持变量。')
          .addTextArea((t) => t.setValue(rule.to.head)
            .onChange(async (v) => { rule.to.head = v; await save(false); }));

        new Setting(box)
          .setName('附录（只在创建时写一次）')
          .setDesc('在 auto 标记下方，之后不再改动。适合放「为什么这样设计」的依据。')
          .addTextArea((t) => t.setValue(rule.to.tail)
            .onChange(async (v) => { rule.to.tail = v; await save(false); }));

        new Setting(box)
          .setName('没写时的占位')
          .setDesc('产物文件已经存在、但源段落被清空时，标记区里显示这段。留空则不动已有的内容。')
          .addTextArea((t) => t.setValue(rule.to.emptyHint)
            .onChange(async (v) => { rule.to.emptyHint = v; await save(false); }));
      } else {
        new Setting(box)
          .setName('结转标记')
          .setDesc('插在结转过来的条目前面，方便一眼看出是搬过来的。')
          .addText((t) => t.setValue(rule.carry.mark)
            .onChange(async (v) => { rule.carry.mark = v; await save(false); }));

        new Setting(box)
          .setName('孤儿项的小标题')
          .setDesc('找不到原来所在子小节的条目挂在这里。{{prevDate}} 会替换成来源日期。')
          .addText((t) => t.setValue(rule.carry.orphanHeading)
            .onChange(async (v) => { rule.carry.orphanHeading = v; await save(false); }));

        new Setting(box)
          .setName('完成行标签')
          .setDesc('写在目标下面那一行的开头，例如「完成：」。结转过来的条目会带上这一行，方便回头填结果。')
          .addText((t) => t.setValue(rule.carry.suffix)
            .onChange(async (v) => { rule.carry.suffix = v; await save(false); }));

        new Setting(box)
          .setName('最多往回找几天')
          .setDesc('超过这个间隔就不结转了，避免断更之后一口气搬回一大堆。')
          .addText((t) => t.setValue(String(rule.carry.maxGapDays))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              rule.carry.maxGapDays = n > 0 ? n : CARRY_MAX_GAP_DAYS;
              await save(false);
            }));
      }

      new Setting(box).addButton((b) => b.setButtonText('删除这条规则').setWarning().onClick(async () => {
        p.settings.rules.splice(idx, 1);
        await p.saveSettings();
        this.display();
      }));
    }
  }

  module.exports = class extends TemplateDerivePlugin {};
} else {
  module.exports = PURE;
}
