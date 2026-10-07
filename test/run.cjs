'use strict';
/*
 * template-derive 纯函数单元测试。
 * 直接用库里的真实模板当素材 —— 空模板必须每段都判为「没写」，
 * 这是「没写就不创建」这条承诺唯一的防线。
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const P = require(path.join(REPO, 'main.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else {
    fail++;
    console.log('  ★失败 ' + name + (extra === undefined ? '' : '   → ' + JSON.stringify(extra)));
  }
}
const group = (t) => console.log('\n' + t);

/* ------------------------------------------------------------ 素材 ---- */

const TEMPLATE_RAW = fs.readFileSync(path.join(FIX, '日记模板.md'), 'utf8');

/** 模拟核心 Daily Notes：把 {{date:...}} 求值。用的就是引擎自己的渲染器。 */
function instantiate(tpl, date) {
  return P.renderTemplate(tpl, {
    date, file: '', name: '', ruleName: '', ruleId: '', sourceMd: '',
    sections: [], sectionBody: '', frontmatter: null, dateFormat: 'YYYY-MM-DD'
  });
}

const EMPTY_TODAY = instantiate(TEMPLATE_RAW, '2026-10-08');
const FILLED = [
  '---',
  'date: 2026-10-07',
  'weekday: 星期三',
  'tags:',
  '  - 日记',
  '---',
  '',
  '## 天气：🌤',
  '## 心情：平静',
  '',
  '---',
  '',
  '## 今日计划',
  '',
  '> [!note]- 这一段为什么这样写',
  '> 这是模板自带的说明，不该被当成用户写的内容。',
  '',
  '### Precision Design and Dimensional Inspection',
  '- [x] 把第三章例题重做一遍（早饭后）',
  '  完成：做了 12 道，对了 9 道',
  '- [ ] 复习坐标变换的推导（午休）',
  '  完成：',
  '### English',
  // ★ 故意留一条「旧的内联写法」，验证老日记不改也能读出来
  '- [x] 背 30 词（早饭后）　完成：',
  '### Fundamentals of Machine Design',
  '- [ ] 看第三章（下午）',
  '  完成：',
  '### 阅读',
  '- [x] 读完《计算机图形学》第 5 章（睡前半小时）',
  '  完成：',
  '- [ ] 接着读第 6 章（睡前半小时）',
  '  完成：',
  '### 锻炼',
  '- [ ] 跑步 3km（晚饭前）',
  '  完成：',
  '### 其他',
  '- [ ] 　',
  '  完成：',
  '',
  '---',
  '',
  '## 今日阅读',
  '',
  '> [!note]- 为什么是这三行',
  '> 说明文字。',
  '',
  '- **读了什么**：读了《计算机图形学》第 5 章，睡前半小时',
  '- **合上书，用自己的话写**（这章在说什么 + 我还记得什么）：讲的是变换矩阵；具体矩阵怎么乘出来的想不起来了',
  '- **跟我有什么关系 / 下次接着读要先解决什么**：明天先把观察矩阵按展开写一遍',
  '',
  '---',
  '',
  '## 今日复盘',
  '',
  '> [!note]- 为什么是这四行',
  '> 说明文字。',
  '',
  '- **去哪（Feed up）**：坐标变换要能自己推',
  '- **走得怎样（Feed back · 进展，哪怕很小）**：过了两章',
  '- **卡在哪 · 只写能改的内部原因**：总想着跳过不画图',
  '- **下一步（明天第一件事 +「如果……就……」）**：先只画一个最简单的坐标系',
  '',
  '## 成长轨迹',
  '',
  '> [!note]- 为什么是这五个分',
  '> 说明文字。',
  '',
  '- 精力：4 / 5　·　专注：3 / 5',
  '- 自主：3 / 5　·　胜任：4 / 5　·　联结：2 / 5',
  '- 今天的小胜：把第三章的例题自己推了一遍',
  '',
  '## 今日金句',
  '> 慢就是快，先把图画出来',
  '',
  '## 本周目标回顾',
  '- [ ] ',
  '',
  '## 随手记',
  '- ',
  ''
].join('\n');

function mkCtx(sourceMd, rule, file, date, sectionTitle) {
  const parsed = P.parseSections(sourceMd);
  const sec = P.getSection(parsed.sections, sectionTitle);
  return P.buildCtx({ rule, file, date, sourceMd, section: sec });
}

const R_REVIEW = P.PRESET_RULES.find((r) => r.id === 'review');
const R_GROWTH = P.PRESET_RULES.find((r) => r.id === 'growth');
const R_READING = P.PRESET_RULES.find((r) => r.id === 'reading');
const FILE7 = 'Personal/Diary/2026-10-07.md';
const ctxRev = mkCtx(FILLED, R_REVIEW, FILE7, '2026-10-07', '今日复盘');
const ctxGro = mkCtx(FILLED, R_GROWTH, FILE7, '2026-10-07', '成长轨迹');
const ctxRead = mkCtx(FILLED, R_READING, FILE7, '2026-10-07', '今日阅读');

/* --------------------------------------------------------- 一、日期 ---- */

group('一、日期与文件名');
ok('YYYY-MM-DD', P.formatDate('2026-10-07', 'YYYY-MM-DD') === '2026-10-07', P.formatDate('2026-10-07', 'YYYY-MM-DD'));
ok('dddd → 星期三', P.formatDate('2026-10-07', 'dddd') === '星期三', P.formatDate('2026-10-07', 'dddd'));
ok('ddd → 周三', P.formatDate('2026-10-07', 'ddd') === '周三', P.formatDate('2026-10-07', 'ddd'));
ok('中英混排 YYYY年M月D日',
  P.formatDate('2026-10-07', 'YYYY年M月D日') === '2026年10月7日',
  P.formatDate('2026-10-07', 'YYYY年M月D日'));
ok('空格式走默认', P.formatDate('2026-10-07', '') === '2026-10-07');
ok('反解 YYYY-MM-DD', P.dateFromFileName('2026-10-07', 'YYYY-MM-DD') === '2026-10-07');
ok('反解 YYYYMMDD', P.dateFromFileName('20261007', 'YYYYMMDD') === '2026-10-07',
  P.dateFromFileName('20261007', 'YYYYMMDD'));
ok('反解 YYYY.M.D 补零', P.dateFromFileName('2026.1.7', 'YYYY.M.D') === '2026-01-07',
  P.dateFromFileName('2026.1.7', 'YYYY.M.D'));
ok('反解中文日期的年', P.dateFromFileName('2026年10月07日', 'YYYY年MM月DD日') === '2026-10-07',
  P.dateFromFileName('2026年10月07日', 'YYYY年MM月DD日'));
ok('不像日期的返回空', P.dateFromFileName('会议记录', 'YYYY-MM-DD') === '',
  P.dateFromFileName('会议记录', 'YYYY-MM-DD'));
ok('跨月差值 2 天', P.daysBetween('2026-10-05', '2026-10-07') === 2);
ok('跨年差值 1 天', P.daysBetween('2026-12-31', '2027-01-01') === 1);

/* --------------------------------------------------- 二、段落解析 ---- */

group('二、段落解析');
const parsedTpl = P.parseSections(TEMPLATE_RAW);
ok('真实模板识别出 9 个二级段落', parsedTpl.sections.length === 9,
  parsedTpl.sections.map((s) => s.title));
ok('frontmatter 抓到了', /weekday:\s*\{\{date:dddd\}\}/.test(parsedTpl.frontmatter || ''), parsedTpl.frontmatter);
ok('### 子标题没被当成段落边界',
  parsedTpl.sections.every((s) => s.title.indexOf('English') < 0 && s.title.indexOf('阅读') !== 0));
ok('取得到「今日计划」', !!P.getSection(parsedTpl.sections, '今日计划'));
ok('取得到「今日复盘」', !!P.getSection(parsedTpl.sections, '今日复盘'));
ok('取得到「成长轨迹」', !!P.getSection(parsedTpl.sections, '成长轨迹'));
ok('取得到「今日阅读」', !!P.getSection(parsedTpl.sections, '今日阅读'));
ok('取得到「今日金句」', !!P.getSection(parsedTpl.sections, '今日金句'));
ok('标题写多两个字也认得（包含匹配）', !!P.getSection(parsedTpl.sections, '复盘'));
ok('取不到的返回 null', P.getSection(parsedTpl.sections, '不存在的段落') === null);

const planBody = P.getSection(P.parseSections(FILLED).sections, '今日计划').body;
ok('子小节抽取正确（阅读里恰好 2 条）',
  P.extractCheckboxLines(P.subSectionBody(planBody, '阅读')).length === 2,
  P.extractCheckboxLines(P.subSectionBody(planBody, '阅读')).length);
ok('子小节抽取正确（锻炼里 1 条）',
  P.extractCheckboxLines(P.subSectionBody(planBody, '锻炼')).length === 1);

/* ------------------------------------------------------- 三、判定 ---- */

group('三、「到底写了没有」（空模板必须全部判为没写）');
for (const [title, extra] of [['今日计划', false], ['今日阅读', false], ['今日复盘', false], ['成长轨迹', true]]) {
  const sec = P.getSection(P.parseSections(EMPTY_TODAY).sections, title);
  const when = { scoreAware: extra };
  ok('空模板的「' + title + '」→ 没写',
    sec && P.substanceCheck(sec.body, when) === false,
    sec ? P.cleanForSubstance(sec.body) : '(段落不存在)');
}
ok('剥壳后长度严格为 0（今日计划）',
  P.cleanLen(P.getSection(P.parseSections(EMPTY_TODAY).sections, '今日计划').body) === 0);
ok('剥壳后长度严格为 0（今日复盘）',
  P.cleanLen(P.getSection(P.parseSections(EMPTY_TODAY).sections, '今日复盘').body) === 0);
ok('剥壳后长度严格为 0（今日阅读，含带括号说明的标签行）',
  P.cleanLen(P.getSection(P.parseSections(EMPTY_TODAY).sections, '今日阅读').body) === 0);
ok('剥壳后长度严格为 0（成长轨迹，含裸 / 5）',
  P.cleanLen(P.getSection(P.parseSections(EMPTY_TODAY).sections, '成长轨迹').body) === 0);

{
  const sec = P.getSection(P.parseSections(FILLED).sections, '今日复盘');
  ok('写了两字就算写了', P.substanceCheck('- **去哪**：推进', {}) === true);
  ok('只打分：不开启 scoreAware 时不算', P.substanceCheck('- 精力：4 / 5', {}) === false);
  ok('只打分：开启 scoreAware 时算', P.substanceCheck('- 精力：4 / 5', { scoreAware: true }) === true);
  ok('写了内容的复盘段算写了', P.substanceCheck(sec.body, {}) === true);
  ok('callout 说明文字不算内容',
    P.substanceCheck('> [!note]- 说明\n> 这里有一大段解释文字，但它是模板自带的。', {}) === false);
  ok('普通引用算内容（金句段就是靠它）',
    P.substanceCheck('> 慢就是快', {}) === true);
}

/* --------------------------------------------------- 四、模板变量 ---- */

group('四、模板变量');
ok('{{date}}', P.renderTemplate('{{date}}', ctxRev) === '2026-10-07', P.renderTemplate('{{date}}', ctxRev));
ok('{{date:dddd}}', P.renderTemplate('{{date:dddd}}', ctxRev) === '星期三');
ok('{{name}}', P.renderTemplate('{{name}}', ctxRev) === '2026-10-07');
ok('{{file}}', P.renderTemplate('{{file}}', ctxRev) === FILE7);
ok('{{link}}', P.renderTemplate('{{link}}', ctxRev) === '[[' + FILE7 + ']]');
ok('{{rule}}', P.renderTemplate('{{rule}}', ctxRev) === '复盘');
ok('{{ruleid}}', P.renderTemplate('{{ruleid}}', ctxRev) === 'review');
ok('{{fm:weekday}}', P.renderTemplate('{{fm:weekday}}', ctxRev) === '星期三', P.renderTemplate('{{fm:weekday}}', ctxRev));
ok('{{section}} = 触发段落正文', P.renderTemplate('{{section}}', ctxRev).indexOf('过了两章') >= 0);
ok('{{section}} 滤掉了 callout 说明',
  P.renderTemplate('{{section}}', ctxRev).indexOf('说明文字') < 0);
ok('{{section:今日金句}} 跨段取，保留引用符',
  P.renderTemplate('{{section:今日金句}}', ctxRev) === '> 慢就是快，先把图画出来',
  P.renderTemplate('{{section:今日金句}}', ctxRev));
ok('{{field:去哪}}', P.renderTemplate('{{field:去哪}}', ctxRev) === '坐标变换要能自己推',
  P.renderTemplate('{{field:去哪}}', ctxRev));
ok('{{field:多候选}}', P.renderTemplate('{{field:哪里,去哪,Feed up}}', ctxRev) === '坐标变换要能自己推');
ok('{{field:段落名 > 关键词}}',
  P.renderTemplate('{{field:成长轨迹 > 今天的小胜}}', ctxRev) === '把第三章的例题自己推了一遍',
  P.renderTemplate('{{field:成长轨迹 > 今天的小胜}}', ctxRev));
ok('{{field:2}} 按序号取', P.renderTemplate('{{field:2}}', ctxRev) === '过了两章',
  P.renderTemplate('{{field:2}}', ctxRev));
ok('{{field:段落名 > 2}} 跨段按序号取',
  P.renderTemplate('{{field:今日阅读 > 2}}', ctxRev).indexOf('具体矩阵怎么乘出来的想不起来了') >= 0,
  P.renderTemplate('{{field:今日阅读 > 2}}', ctxRev));
ok('{{score:精力}}', P.renderTemplate('{{score:精力}}', ctxGro) === '4 / 5', P.renderTemplate('{{score:精力}}', ctxGro));
ok('{{score:自主}}', P.renderTemplate('{{score:自主}}', ctxGro) === '3 / 5');
ok('{{score:没打的分}} → 空（交给默认值）', P.renderTemplate('{{score:靠谱}}', ctxGro) === '');
const checksTxt = P.renderTemplate('{{checks:今日计划}}', ctxRev);
const checksLines = checksTxt.split('\n');
ok('{{checks:今日计划}} 拿到 7 条（空条目被丢掉）',
  (checksTxt.match(/^- \[[ x]\] /gm) || []).length === 7, checksLines);
ok('{{checks:今日计划/阅读}} 只拿阅读小节',
  (P.renderTemplate('{{checks:今日计划/阅读}}', ctxRev).match(/^- \[[ x]\] /gm) || []).length === 2,
  P.renderTemplate('{{checks:今日计划/阅读}}', ctxRev));
ok('★ 勾选状态 + 完成结果分两行带过来',
  checksTxt.indexOf('- [x] 把第三章例题重做一遍（早饭后）\n  完成：做了 12 道，对了 9 道') >= 0,
  checksLines.slice(0, 4));
ok('没写结果的项不补空的完成行（省得产物里一排空「完成：」）',
  checksTxt.indexOf('- [ ] 复习坐标变换的推导（午休）\n  完成：') < 0 &&
  checksTxt.indexOf('- [ ] 复习坐标变换的推导（午休）\n') >= 0, checksLines);
ok('★ 旧的内联写法照样读得出结果（背 30 词那行）',
  checksTxt.indexOf('- [x] 背 30 词（早饭后）') >= 0, checksLines);
ok('未勾选的还是 - [ ]',
  checksTxt.indexOf('- [ ] 复习坐标变换的推导（午休）') >= 0);

group('五、默认值与未知变量');
ok('取不到用默认值', P.renderTemplate('{{field:根本没这个|兜底}}', ctxRev) === '兜底');
ok('有值时不用默认值', P.renderTemplate('{{field:去哪|兜底}}', ctxRev) === '坐标变换要能自己推');
ok('{{date|兜底}} 有值所以不用兜底', P.renderTemplate('{{date|兜底}}', ctxRev) === '2026-10-07');
ok('默认值里可以有标点和空格',
  P.renderTemplate('{{field:没有|（没写 —— 今天要去的方向是什么？）}}', ctxRev) === '（没写 —— 今天要去的方向是什么？）');
ok('未知变量原样保留（不吃掉核心 Templates 的 {{title}}）',
  P.renderTemplate('{{title}}', ctxRev) === '{{title}}', P.renderTemplate('{{title}}', ctxRev));
ok('一行里多个变量各自求值',
  P.renderTemplate('{{date}} 的 {{rule}}：{{field:去哪}}', ctxRev) === '2026-10-07 的 复盘：坐标变换要能自己推',
  P.renderTemplate('{{date}} 的 {{rule}}：{{field:去哪}}', ctxRev));

/* --------------------------------------------------- 六、auto 标记 ---- */

group('六、auto 标记区');
ok('认新标记', P.hasAutoBlock('前\n' + P.AUTO_START + '\nA\n' + P.AUTO_END + '\n后') === true);
ok('认第一版留下的 wb:auto 标记',
  P.hasAutoBlock('前\n<!-- wb:auto:start -->\nA\n<!-- wb:auto:end -->\n后') === true);
ok('没有标记 → false', P.hasAutoBlock('随便写点什么') === false);
ok('只有开始没有结束 → false', P.hasAutoBlock('x\n' + P.AUTO_START + '\nA') === false);
ok('替换只动标记之间',
  P.upsertAutoBlock('前\n' + P.AUTO_START + '\nA\n' + P.AUTO_END + '\n后', 'B')
    === '前\n' + P.AUTO_START + '\nB\n' + P.AUTO_END + '\n后');
ok('旧标记原地保留（不迁移用户的文件）',
  P.upsertAutoBlock('前\n<!-- wb:auto:start -->\nA\n<!-- wb:auto:end -->\n后', 'B')
    === '前\n<!-- wb:auto:start -->\nB\n<!-- wb:auto:end -->\n后',
  P.upsertAutoBlock('前\n<!-- wb:auto:start -->\nA\n<!-- wb:auto:end -->\n后', 'B'));
ok('内容没变时返回原字符串（防死循环）',
  P.upsertAutoBlock('前\n' + P.AUTO_START + '\nB\n' + P.AUTO_END + '\n后', 'B')
    === '前\n' + P.AUTO_START + '\nB\n' + P.AUTO_END + '\n后');

/* --------------------------------------------------------- 七、结转 ---- */

group('七、结转');
const co = P.carryOver({
  prevMd: FILLED,
  todayMd: EMPTY_TODAY,
  prevDate: '2026-10-07',
  todayDate: '2026-10-08',
  section: '今日计划',
  mark: '↺',
  orphanHeading: '### ↺ 结转自 {{prevDate}}',
  suffix: '　完成：'
});
ok('只搬没做完的 4 条', co.changed === true && co.added === 4, co.added);
{
  const lines = co.text.split('\n');
  // ★ 切到下一个标题为止 —— 别写死「取后面 2 行」，占位行数一变就崩
  const sub = (name) => {
    const i = lines.indexOf('### ' + name);
    if (i < 0) return [];
    const rest = [];
    for (let k = i + 1; k < lines.length; k++) {
      if (/^#{2,6}\s/.test(lines[k])) break;
      rest.push(lines[k]);
    }
    return rest.filter((l) => l.trim());
  };
  ok('「复习坐标变换的推导」回到 Precision 小节内',
    sub('Precision Design and Dimensional Inspection').some((l) => l.indexOf('复习坐标变换的推导') >= 0),
    sub('Precision Design and Dimensional Inspection'));
  ok('「看第三章」回到机器设计小节内',
    sub('Fundamentals of Machine Design').some((l) => l.indexOf('看第三章') >= 0),
    sub('Fundamentals of Machine Design'));
  ok('「接着读第 6 章」回到阅读小节内',
    sub('阅读').some((l) => l.indexOf('接着读第 6 章') >= 0), sub('阅读'));
  ok('「跑步 3km」回到锻炼小节内',
    sub('锻炼').some((l) => l.indexOf('跑步 3km') >= 0), sub('锻炼'));
  ok('四条都带 ↺', (co.text.match(/- \[ \] ↺ /g) || []).length === 4,
    (co.text.match(/- \[ \] ↺ /g) || []).length);
  ok('已完成的没被带走', co.text.indexOf('↺ 把第三章例题重做一遍') < 0);
  ok('已经写完结果的没被带走', co.text.indexOf('↺ 背 30 词') < 0);
  ok('没读的那本没被带走（勾上了）', co.text.indexOf('↺ 读完《计算机图形学》') < 0);
  ok('没有多余的孤儿小节（每条都有归宿）', co.text.indexOf('结转自') < 0);
  ok('没被插到「今日阅读」段之后（再往后就不归它管了）',
    (() => {
      const after = lines.slice(lines.indexOf('## 今日阅读'));
      return after.every((l) => l.indexOf('↺') < 0);
    })(),
    lines.slice(lines.indexOf('## 今日阅读')).filter((l) => l.indexOf('↺') >= 0));
}
{
  const co2 = P.carryOver({
    prevMd: FILLED, todayMd: co.text, prevDate: '2026-10-07', todayDate: '2026-10-08',
    section: '今日计划', mark: '↺'
  });
  ok('再跑一次是幂等的（不会重复搬）', co2.changed === false && co2.added === 0, co2.added);
}

/* ----------------------------------------------------- 八、规则匹配 ---- */

group('八、规则匹配与自定义规则');
ok('日记文件命中 4 条预设规则',
  P.matchRules(P.PRESET_RULES, FILE7).length === 4,
  P.matchRules(P.PRESET_RULES, FILE7).map((r) => r.id));
ok('别的文件夹不命中', P.matchRules(P.PRESET_RULES, 'Subjects/高数/S01.md').length === 0);
ok('文件名不像日期的的跳过', P.matchRules(P.PRESET_RULES, 'Personal/Diary/随手记.md').length === 0);
ok('子文件夹也命中', P.matchRules(P.PRESET_RULES, 'Personal/Diary/2026/2026-10-07.md').length === 4);
ok('非 md 跳过', P.matchRules(P.PRESET_RULES, 'Personal/Diary/2026-10-07.canvas').length === 0);
ok('停用的规则不命中',
  P.matchRules([Object.assign({}, R_REVIEW, { enabled: false })], FILE7).length === 0);

const custom = P.normalizeRule({
  id: 'weekly', name: '周复盘',
  from: { folder: 'Work/Weekly', dateFormat: 'YYYY.MM.DD' },
  when: { section: '小结' },
  to: { path: 'Work/Archive/{{date}}-weekly.md', template: '', head: '# {{date}} 周复盘' }
});
ok('自定义日期格式命中', P.matchRules([custom], 'Work/Weekly/2026.10.07.md').length === 1);
ok('格式不符的不命中', P.matchRules([custom], 'Work/Weekly/2026-10-07.md').length === 0);
const ctxCustom = mkCtx(FILLED, custom, 'Work/Weekly/2026.10.07.md', '2026-10-07', '今日复盘');
ok('路径模板里的 {{date}} 跟着规则的日期格式走',
  P.renderPath(custom.to.path, ctxCustom) === 'Work/Archive/2026.10.07-weekly.md',
  P.renderPath(custom.to.path, ctxCustom));
ok('想固定格式就显式写 {{date:YYYY-MM-DD}}',
  P.renderPath('Work/Archive/{{date:YYYY-MM-DD}}-weekly.md', ctxCustom) === 'Work/Archive/2026-10-07-weekly.md',
  P.renderPath('Work/Archive/{{date:YYYY-MM-DD}}-weekly.md', ctxCustom));
ok('路径模板挡掉 ../',
  P.renderPath('A/../B/{{date:YYYY-MM-DD}}.md', ctxCustom) === 'B/2026-10-07.md',
  P.renderPath('A/../B/{{date:YYYY-MM-DD}}.md', ctxCustom));
ok('没写扩展名时自动补 .md',
  P.renderPath('Work/Archive/{{date:YYYY-MM-DD}}', ctxCustom) === 'Work/Archive/2026-10-07.md');
ok('缺字段的规则被补全（id 自动生成）',
  typeof P.normalizeRule({ name: 'x' }).id === 'string' && P.normalizeRule({ name: 'x' }).id.length > 3);

const anyName = P.normalizeRule({
  id: 'card', name: '复习卡',
  from: { folder: 'Subjects/数据结构', dateFormat: '*' },
  when: { section: '自测' },
  to: { path: 'Reviews/{{name}} 复习卡.md', template: '', head: '# {{name}} · {{rule}}' }
});
ok('★ 文件名任意模式（*）：任意文件名都命中',
  P.matchRules([anyName], 'Subjects/数据结构/S03 树.md').length === 1);
ok('* 模式：别的文件夹不命中', P.matchRules([anyName], 'Subjects/物理/S03.md').length === 0);
{
  const c = mkCtx(FILLED, anyName, 'Subjects/数据结构/S03 树.md', '', '今日复盘');
  ok('* 模式：{{key}} / {{name}} 拿到文件名',
    P.renderTemplate('{{key}}', c) === 'S03 树' && P.renderTemplate('{{name}}', c) === 'S03 树',
    [P.renderTemplate('{{key}}', c), P.renderTemplate('{{name}}', c)]);
  ok('* 模式：{{date}} 是空的（交给默认值）',
    P.renderTemplate('{{date}}', c) === '' && P.renderTemplate('{{date|无日期}}', c) === '无日期',
    P.renderTemplate('{{date}}', c));
  ok('* 模式：路径用文件名',
    P.renderPath(anyName.to.path, c) === 'Reviews/S03 树 复习卡.md',
    P.renderPath(anyName.to.path, c));
}

/* ------------------------------------------------- 九、端到端跑规则 ---- */

function memIo(files) {
  const store = new Map(Object.entries(files || {}));
  const written = [];
  return {
    store, written,
    exists: async (p) => store.has(p),
    read: async (p) => {
      if (!store.has(p)) throw new Error('ENOENT ' + p);
      return store.get(p);
    },
    write: async (p, t) => { store.set(p, t); written.push(p); },
    list: async (dir) => [...store.keys()].filter((k) => k.startsWith(dir + '/'))
  };
}

const TPL = {};
for (const n of ['复盘', '成长轨迹', '阅读记录']) {
  TPL['Templates/衍生/' + n + '.md'] = fs.readFileSync(path.join(REPO, 'templates', n + '.md'), 'utf8');
}

(async function () {
  group('九、端到端：填好的日记 → 三个产物');
  {
    const io = memIo(Object.assign({ 'Personal/Diary/2026-10-07.md': FILLED }, TPL));
    const res = await P.runForFile(P.PRESET_RULES, 'Personal/Diary/2026-10-07.md', io, { state: {}, carry: true });
    const kinds = res.actions.map((a) => a.ruleId + ':' + a.result).sort();
    ok('没给 prevPath 时结转规则不产生动作（但会记账，避免反复扫目录）',
      !res.actions.some((a) => a.ruleId === 'plan-carry'), kinds);
    ok('三份产物都创建了',
      kinds.indexOf('review:created') >= 0 && kinds.indexOf('growth:created') >= 0 && kinds.indexOf('reading:created') >= 0,
      kinds);
    ok('模板文件本身没被写', io.written.every((p) => p.indexOf('Templates/') !== 0), io.written);

    const rev = io.store.get('Personal/Review/2026-10-07.md') || '';
    ok('复盘：有 frontmatter + 标题', rev.indexOf('type: 复盘') >= 0 && rev.indexOf('# 2026-10-07 复盘') >= 0);
    ok('复盘：源文件双链在 frontmatter 里', rev.indexOf('source: "[[Personal/Diary/2026-10-07.md]]"') >= 0,
      rev.split('\n').slice(0, 9));
    ok('复盘：有 auto 标记', P.hasAutoBlock(rev));
    ok('复盘：调用了 Hattie 的依据附录', rev.indexOf('Hattie') >= 0);
    ok('复盘：计划兑现是 7 条复选框', (rev.match(/^- \[[ x]\] /gm) || []).length === 7,
      (rev.match(/^- \[[ x]\] /gm) || []).length);
    ok('复盘：勾选状态 + 完成结果都还原了',
      rev.indexOf('- [x] 把第三章例题重做一遍（早饭后）\n  完成：做了 12 道，对了 9 道') >= 0,
      rev.split('\n').filter((l) => l.indexOf('第三章') >= 0));
    ok('复盘：四个字段都搬过来了',
      ['坐标变换要能自己推', '过了两章', '总想着跳过不画图', '先只画一个最简单的坐标系'].every((s) => rev.indexOf(s) >= 0));
    ok('复盘：跨段取到了「今天的小胜」', rev.indexOf('把第三章的例题自己推了一遍') >= 0);
    ok('复盘：没有残留未替换的 {{', rev.indexOf('{{') < 0, (rev.match(/\{\{[^}]*\}\}/g) || []).slice(0, 3));
    ok('复盘：callout 说明没被搬进产物', rev.indexOf('这是模板自带的说明') < 0);

    const gro = io.store.get('Personal/Growth Track/2026-10-07.md') || '';
    ok('成长轨迹：表头 + 分隔线 + 5 行 = 7 行以 | 开头', (gro.match(/^\| /gm) || []).length === 7,
      (gro.match(/^\| /gm) || []).length);
    ok('成长轨迹：分数正确',
      gro.indexOf('| 3 / 5 |') >= 0 && gro.indexOf('| 4 / 5 |') >= 0 && gro.indexOf('| 2 / 5 |') >= 0,
      gro.split('\n').filter((l) => l.indexOf('| ') === 0));
    ok('成长轨迹：精力 4 / 5、专注 3 / 5', gro.indexOf('| 4 / 5 |') >= 0 && gro.indexOf('| 3 / 5 |') >= 0);
    ok('成长轨迹：金句跨段带过来了', gro.indexOf('慢就是快，先把图画出来') >= 0);
    ok('成长轨迹：没有残留 {{', gro.indexOf('{{') < 0);
    ok('成长轨迹：引用了自我决定理论', gro.indexOf('自我决定理论') >= 0);

    const read = io.store.get('Personal/Reading/2026-10-07.md') || '';
    ok('阅读记录：三个小节都在',
      read.indexOf('## 今天读了什么') >= 0 &&
      read.indexOf('## 合上书，用自己的话写') >= 0 &&
      read.indexOf('## 跟我有什么关系') >= 0);
    ok('★ 阅读记录：带括号说明那行的内容没丢（真实模板写过这个坑）',
      read.indexOf('具体矩阵怎么乘出来的想不起来了') >= 0);
    ok('阅读记录：读了什么也在', read.indexOf('读了《计算机图形学》第 5 章') >= 0);
    ok('阅读记录：第三行在', read.indexOf('观察矩阵按展开写一遍') >= 0);
    ok('阅读记录：计划里的阅读带过来了（2 条）',
      (read.match(/^- \[[ x]\] /gm) || []).length === 2,
      (read.match(/^- \[[ x]\] /gm) || []).length);
    ok('阅读记录：没残留 {{', read.indexOf('{{') < 0);
  }

  group('十、端到端：空日记 → 什么都不生成');
  {
    const io = memIo(Object.assign({ 'Personal/Diary/2026-10-08.md': EMPTY_TODAY }, TPL));
    await P.runForFile(P.PRESET_RULES, 'Personal/Diary/2026-10-08.md', io, { state: {}, carry: true });
    ok('★ 一个文件都没写', io.written.length === 0, io.written);
  }

  group('十一、端到端：只打了分 → 只生成成长轨迹');
  {
    const only = EMPTY_TODAY.replace('- 精力：　/ 5　·　专注：　/ 5', '- 精力：4 / 5　·　专注：3 / 5');
    const io = memIo(Object.assign({ 'Personal/Diary/2026-10-08.md': only }, TPL));
    await P.runForFile(P.PRESET_RULES, 'Personal/Diary/2026-10-08.md', io, { state: {}, carry: true });
    ok('只写了成长轨迹段', io.written.length === 1 && io.written[0] === 'Personal/Growth Track/2026-10-08.md',
      io.written);
    ok('成长轨迹里精力分数在', (io.store.get('Personal/Growth Track/2026-10-08.md') || '').indexOf('| 4 / 5 |') >= 0);
    ok('未填的维度是破折号', (io.store.get('Personal/Growth Track/2026-10-08.md') || '').indexOf('| — |') >= 0);
  }

  group('十二、端到端：手建的文件不被动');
  {
    const io = memIo(Object.assign({
      'Personal/Diary/2026-10-07.md': FILLED,
      'Personal/Review/2026-10-07.md': '# 我自己写的复盘\n\n不带你那个标记。\n'
    }, TPL));
    const res = await P.runForFile(P.PRESET_RULES, 'Personal/Diary/2026-10-07.md', io, { state: {}, carry: false });
    ok('手建文件原样不动',
      io.store.get('Personal/Review/2026-10-07.md') === '# 我自己写的复盘\n\n不带你那个标记。\n');
    ok('报了 foreign',
      res.actions.some((a) => a.ruleId === 'review' && a.result === 'foreign'),
      res.actions.map((a) => a.ruleId + ':' + a.result));
  }

  group('十三、端到端：标记外手写的内容不被覆盖');
  {
    const withNotes = '# 2026-10-07 复盘\n\n' + P.AUTO_START + '\n旧的\n' + P.AUTO_END + '\n\n## 我自己加的一节\n\n这段话必须活下来。\n';
    const io = memIo(Object.assign({
      'Personal/Diary/2026-10-07.md': FILLED,
      'Personal/Review/2026-10-07.md': withNotes
    }, TPL));
    await P.runForFile(P.PRESET_RULES, 'Personal/Diary/2026-10-07.md', io, { state: {}, carry: false });
    const out = io.store.get('Personal/Review/2026-10-07.md');
    ok('标记内换成新内容', out.indexOf('过了两章') >= 0);
    ok('★ 标记外我加的那一节活下来了', out.indexOf('这段话必须活下来。') >= 0);
    ok('标题那行也没被动', out.indexOf('# 2026-10-07 复盘') >= 0);
  }

  group('十四、端到端：源段落被清空 → 换占位、不删文件');
  {
    const io = memIo(Object.assign({
      'Personal/Diary/2026-10-08.md': EMPTY_TODAY,
      'Personal/Review/2026-10-08.md': '头\n' + P.AUTO_START + '\n昨天的内容\n' + P.AUTO_END + '\n尾\n'
    }, TPL));
    await P.runForFile(P.PRESET_RULES, 'Personal/Diary/2026-10-08.md', io, { state: {}, carry: false });
    const out = io.store.get('Personal/Review/2026-10-08.md');
    ok('换成空提示', out.indexOf('今天没写复盘') >= 0, out);
    ok('文件没被删', io.store.has('Personal/Review/2026-10-08.md'));
    ok('头尾还在', out.indexOf('头') === 0 && out.indexOf('尾') > 0);
  }

  group('十五、端到端：没配模板文件时原样搬段落');
  {
    const raw = [
      '## 小结', '', '- 本周完成了 A 和 B', '- 下周先做 C', ''
    ].join('\n');
    const io = memIo({ 'Work/Weekly/2026.10.07.md': raw });
    const res = await P.runForFile([custom], 'Work/Weekly/2026.10.07.md', io, { state: {}, carry: false });
    const out = io.store.get('Work/Archive/2026.10.07-weekly.md') || '';
    ok('建了产物', res.actions.some((a) => a.result === 'created'), res.actions);
    ok('回退成原样搬段落', out.indexOf('- 本周完成了 A 和 B') >= 0, out);
    ok('文件头用规则的 head（{{date}} 在同一条规则里保持一致，都跟着 YYYY.MM.DD）',
      out.indexOf('# 2026.10.07 周复盘') >= 0, out.split('\n').slice(0, 3));
    ok('没配 emptyHint → 标记区拿到的是段落原文',
      out.indexOf('- 下周先做 C') >= 0, out);
  }

  group('十六、端到端：结转真的改了源文件');
  {
    const io = memIo(Object.assign({ 'Personal/Diary/2026-10-07.md': FILLED }, TPL));
    const io2 = memIo(Object.assign({
      'Personal/Diary/2026-10-07.md': FILLED,
      'Personal/Diary/2026-10-08.md': EMPTY_TODAY
    }, TPL));
    await P.runForFile(P.PRESET_RULES, 'Personal/Diary/2026-10-08.md', io2, {
      state: {}, carry: true, prevPath: 'Personal/Diary/2026-10-07.md', prevDate: '2026-10-07'
    });
    const out = io2.store.get('Personal/Diary/2026-10-08.md');
    ok('源文件被写入了 4 条 ↺', (out.match(/- \[ \] ↺ /g) || []).length === 4,
      (out.match(/- \[ \] ↺ /g) || []).length);
    ok('今天的计划段里有「复习坐标变换的推导」', out.indexOf('复习坐标变换的推导') >= 0);
    ok('10-07 那份没被动过', io2.store.get('Personal/Diary/2026-10-07.md') === FILLED);
    ok('没给 prevPath 的另一次跑没改动源文件',
      !io.written.some((p) => p === 'Personal/Diary/2026-10-07.md'));
  }

  group('十七、端到端：非日记场景（课程笔记 → 复习卡）');
  {
    const cardRule = P.normalizeRule({
      id: 'card', name: '复习卡',
      from: { folder: 'Subjects/数据结构', dateFormat: '*' },
      when: { section: '自测' },
      to: {
        path: 'Reviews/{{name}} 复习卡.md',
        template: '',
        head: '# {{name}} · 复习卡',
        tail: '> [!note]- 为什么先自测\n> 提取练习比重读有效得多。'
      }
    });
    const src = [
      '---',
      'course: 数据结构',
      '---',
      '',
      '## 自测',
      '',
      '- **中序遍历怎么写**：左-根-右',
      '- **什么情况下退化成链表**：插入有序时',
      '',
      '## 今天没写东西的一段',
      '',
      ''
    ].join('\n');
    const io = memIo({ 'Subjects/数据结构/S03 树.md': src });
    const res = await P.runForFile([cardRule], 'Subjects/数据结构/S03 树.md', io, { state: {}, carry: false });
    const out = io.store.get('Reviews/S03 树 复习卡.md') || '';
    ok('建了产物，路径用文件名', res.actions.some((a) => a.result === 'created'), res.actions);
    ok('产物在 Reviews/S03 树 复习卡.md', !!out, [...io.store.keys()]);
    ok('文件头渲染了文件名', out.indexOf('# S03 树 · 复习卡') >= 0, out.split('\n').slice(0, 3));
    ok('没配模板 → 原样搬「自测」段', out.indexOf('中序遍历怎么写') >= 0, out);
    ok('附录写进去了', out.indexOf('提取练习比重读有效得多') >= 0);
    ok('只搬了「自测」段，没搬别的段', out.indexOf('今天没写东西的一段') < 0, out);
  }

  group('十八、预设自检');  {
    ok('预设规则都能被 normalize 且 id 唯一',
      (() => {
        const ids = P.normalizeRules(P.PRESET_RULES).map((r) => r.id);
        return new Set(ids).size === ids.length;
      })());
    ok('预设里的三个模板路径都以 Templates/衍生/ 开头',
      P.PRESET_RULES.filter((r) => r.kind === 'derive')
        .every((r) => r.to.template.indexOf('Templates/衍生/') === 0));
    ok('三个模板文件都在仓库里',
      ['复盘', '成长轨迹', '阅读记录'].every((n) => !!TPL['Templates/衍生/' + n + '.md']));
    ok('旧状态能被迁移（没有 rules 字段 → 落预设）',
      P.migrateState({ lastCarry: '2026-10-07' }).rules.length === P.PRESET_RULES.length);
    ok('已有规则不会被迁移覆盖',
      P.migrateState({ rules: [{ id: 'a', name: 'A' }] }).rules.length === 1);
  }

  group('十九、目标一行 · 完成结果一行');  {
    const TWO = [
      '- [ ] 背 30 词（早饭后）',
      '  完成：对了 9 道',
      '- [ ] 复习坐标变换的推导',
      '  完成：',
      '- [x] 把第三章例题重做一遍',
      '  完成：自己推了一遍，卡在第 2 步'
    ].join('\n');
    const items = P.extractCheckboxItems(TWO);
    ok('一项横跨两行：3 条计划解析出 3 项', items.length === 3, items);
    ok('目标和结果各自归位',
      items[0].item === '背 30 词（早饭后）' && items[0].note === '对了 9 道', items[0]);
    ok('写了结果就算做完（哪怕没勾上）', items[0].done === true, items[0].done);
    ok('完成行空着 → 未完成', items[1].note === '' && items[1].done === false, items[1]);
    ok('勾上 + 写结果，两个信号都认',
      items[2].done === true && items[2].note === '自己推了一遍，卡在第 2 步', items[2]);

    const BLANK = ['- [ ] 　', '  完成：'].join('\n');
    ok('空占位（目标空 + 完成空）→ 0 项', P.extractCheckboxItems(BLANK).length === 0);
    ok('整段仍判为「没写」（空日记不会凭空生成文件）', P.hasSubstance(BLANK) === false);

    ok('旧内联写法读出来的结果一样',
      P.extractCheckboxItems('- [ ] 背 30 词　完成：对了 9 道')[0].note === '对了 9 道');
    ok('★ 手改的混合写法（目标行 + 单独一行「- [ ] 完成：」）合成一项而不是两项',
      (() => {
        const r = P.extractCheckboxItems(['- [ ] 背课后题', '- [ ] 完成：做了 12 道'].join('\n'));
        return r.length === 1 && r[0].item === '背课后题' && r[0].note === '做了 12 道';
      })());

    const out2 = P.checkboxLinesToMd(P.extractCheckboxItems(TWO));
    ok('完成项输出两行（目标 + 缩进的完成行）',
      out2.indexOf('- [x] 把第三章例题重做一遍\n  完成：自己推了一遍，卡在第 2 步') >= 0, out2);
    ok('没写结果的不补空的完成行（产物里不留一排空「完成：」）',
      out2.indexOf('复习坐标变换的推导\n  完成：') < 0, out2);

    const today2 = ['## 今日计划', '', '### English', '- [ ] 　', '  完成：'].join('\n');
    const prev2 = ['## 今日计划', '', '### English', '- [ ] 背 30 词（早饭后）', '  完成：',
      '- [x] 读完第 4 章', '  完成：读完了'].join('\n');
    const co2 = P.carryOver({
      prevMd: prev2, todayMd: today2, prevDate: '2026-10-07', todayDate: '2026-10-08',
      section: '今日计划', mark: '↺'
    });
    ok('结转只搬没做完的那条（做完的没被带走）', co2.added === 1, co2.added);
    ok('★ 结转项也是目标一行 + 完成结果一行',
      co2.text.indexOf('- [ ] ↺ 背 30 词（早饭后）\n  完成：') >= 0, co2.text.split('\n'));
    ok('完成行写了东西的就不再被搬', (() => {
      const prev3 = ['## 今日计划', '### English', '- [ ] 背 30 词（早饭后）', '  完成：做了 12 道'].join('\n');
      const r3 = P.carryOver({
        prevMd: prev3, todayMd: today2, prevDate: 'p', todayDate: 't',
        section: '今日计划', mark: '↺'
      });
      return r3.changed === false;
    })());
    ok('旧配置里的 suffix「　完成：」被归一（不会输出成「  　完成：」）', (() => {
      const prev4 = ['## 今日计划', '### A', '- [ ] 甲'].join('\n');
      const today4 = ['## 今日计划', '### A', '- [ ] 　', '  完成：'].join('\n');
      const r4 = P.carryOver({
        prevMd: prev4, todayMd: today4, prevDate: 'p', todayDate: 't',
        section: '今日计划', mark: '↺', suffix: '　完成：'
      });
      return r4.text.indexOf('  完成：') >= 0 && r4.text.indexOf('  　完成：') < 0;
    })());
    ok('预设里的完成行标签是「完成：」', P.normalizeRules(P.PRESET_RULES)[0].carry.suffix === '完成：',
      P.normalizeRules(P.PRESET_RULES)[0].carry.suffix);
  }

  group('二十、回车续行（按回车自动补下一条）');  {
    const at = (lines, i, opts) => {
      const n = lines.length;
      return P.taskEnterAction((k) => (k < 0 || k >= n ? null : lines[k]), i, opts);
    };

    /* --- 该交回 Obsidian 的，一律 null --- */
    ok('空方框行按回车 → 不接管（免得灌出一堆空骨架）',
      at(['- [ ] ', '- [ ] ', '  完成：'], 0) === null);
    ok('★ 全角空格占位的「- [ ] 　」也算没写目标',
      at(['- [ ] 　', '### English'], 0) === null);
    ok('★ 模板里的空占位下面紧跟着「完成：」，照样一个字都不改 —— '
      + '接管了光标会往下跑，用户接着打字就把目标打进了结果行',
      at(['- [ ] 　', '  完成：'], 0) === null);
    ok('空条目（目标空 + 结果空）→ 不接管，连按回车能退出列表',
      at(['- [ ] ', '  完成：', '### 下一节'], 1) === null);
    ok('顶格的「完成：」不归我们管', at(['完成：做了 12 道', 'x'], 0) === null);
    ok('普通文字行不管', at(['随手记点什么', 'x'], 0) === null);
    ok('小标题不管', at(['### English', 'x'], 0) === null);
    ok('旧内联写法不管（他不用两行格式）',
      at(['- [ ] 背 30 词　完成：对了 9 道', '### English'], 0) === null);
    ok('行号越界不炸', at(['- [ ] x'], 99) === null);

    /* --- 在目标行按回车 --- */
    {
      const a = at(['- [ ] 背 30 词', '  完成：'], 0);
      ok('下面已有「完成：」行 → 光标送过去，不新开一行',
        a && a.mode === 'cursor' && a.line === 1 && a.ch === '  完成：'.length, a);
    }
    {
      const a = at(['### English', '- [ ] 背 30 词'], 1);
      ok('下面没有完成行 → 补一行缩进的「完成：」，光标落在后面',
        a && a.mode === 'insert' && a.text === '\n  完成：' && a.cursor.back === 0
          && a.cursor.ch === '  完成：'.length, a);
    }
    {
      const a = at(['- [ ] 背 30 词', '### English'], 0);
      ok('下面顶着小标题也照样补', a && a.mode === 'insert' && a.text === '\n  完成：', a);
    }
    ok('文档最后一行（getLine 返回 null）也照样补',
      (() => { const a = at(['- [ ] 背 30 词'], 0); return !!a && a.mode === 'insert'; })());

    /* --- 在完成行按回车 --- */
    {
      const a = at(['- [ ] 背 30 词', '  完成：对了 9 道', '### 下一节'], 1);
      ok('★ 在「完成：」行按回车 → 自动开始下一条（两行骨架）',
        a && a.mode === 'insert' && a.text === '\n- [ ] \n  完成：'
          && a.cursor.back === 1 && a.cursor.ch === '- [ ] '.length, a);
    }
    {
      const a = at(['  - [ ] 背 30 词', '    完成：对了 9 道', '  尾巴'], 1);
      ok('嵌套列表按原缩进续',
        a && a.mode === 'insert' && a.text === '\n  - [ ] \n    完成：'
          && a.cursor.ch === '  - [ ] '.length, a);
    }
    {
      const a = at(['- [ ] 背 30 词', '  完成：对了 9 道', '- [ ] ', '  完成：'], 1);
      ok('下面已经有空占位 → 光标跳到那个方框后面',
        a && a.mode === 'cursor' && a.line === 2 && a.ch === '- [ ] '.length, a);
    }
    {
      const a = at(['- [ ] 背 30 词', '  一些备注', '  完成：'], 2);
      ok('目标行和完成行之间夹着别的缩进行，也认得这是同一条',
        a && a.mode === 'insert', a);
    }
    {
      const a = at(['- [ ] 背 30 词', '### 下一节'], 0, { label: '结果：' });
      ok('完成行标签跟着规则的 carry.suffix 走', a && a.text === '\n  结果：', a);
    }
  }

  /* --------------------------------------- ### 小标题行尾回车 → 补一组 ---- */
  {
    // 传 ch（光标列）：只有停在行尾才接管
    const atH = (arr, ln, ch, opts) => P.taskEnterAction(
      (i) => (arr[i] === undefined ? null : arr[i]), ln,
      Object.assign({ label: '完成：' }, opts || {}, { ch: ch === undefined ? arr[ln].length : ch }));

    group('### 小标题行尾回车');
    {
      const a = atH(['### Precision Design', ''], 0);
      ok('空小节 → 补出一组，光标停在方框后面',
        a && a.mode === 'insert' && a.text === '\n- [ ] \n  完成：'
          && a.cursor.back === 1 && a.cursor.ch === '- [ ] '.length, a);
    }
    {
      const a = atH(['### Precision Design', '### English'], 0);
      ok('下面紧挨着另一个小标题 → 照样补', a && a.mode === 'insert', a);
    }
    {
      const a = atH(['### 阅读', '- [ ] 　', '  完成：'], 0);
      ok('下面已经有模板的空占位 → 光标送过去，不重复插',
        a && a.mode === 'cursor' && a.line === 1 && a.ch === '- [ ] '.length, a);
    }
    {
      const a = atH(['### 阅读', '- [ ] 已经写好的目标', '  完成：'], 0);
      ok('下面是一条写好的待办 → 不接管', a === null, a);
    }
    {
      const a = atH(['### 阅读', '随手记一行'], 0);
      ok('下面是别的正文 → 不接管', a === null, a);
    }
    ok('光标不在行尾 → 不接管', atH(['### 阅读', ''], 0, 4) === null);
    ok('## 段落标题不归它管（那是段落，不是条目分组）', atH(['## 今日计划', ''], 0) === null);
    {
      const a = atH(['### 阅读   ', ''], 0);
      ok('标题末尾带空格也认', a && a.mode === 'insert', a);
    }
    {
      const a = atH(['  ### 阅读', ''], 0);
      ok('标题有缩进 → 补出来的两行跟着缩进',
        a && a.text === '\n  - [ ] \n    完成：' && a.cursor.ch === '  - [ ] '.length, a);
    }
  }

  /* ------------------------------------- 学科标题行回车 → 建当天笔记 ---- */
  {
    const SUBJ = 'Fundamentals of Digital Design and Manufacturing Technology';
    const only = {}; only[SUBJ] = true;
    const resolve = (t) => (only[t] ? t : null);
    const lines = [
      '## 今日计划',
      '### ' + SUBJ,
      '- [ ] 　',
      '  完成：',
      '### 阅读',
      '- [ ] 　'
    ];
    const at2 = (ln, ch) => P.subjectEnterAction(
      (i) => (lines[i] === undefined ? null : lines[i]), ln,
      ch === undefined ? lines[ln].length : ch, resolve,
      { date: '2026-10-07', diary: 'Personal/Diary/2026-10-07.md' });
    const withNext = (next) => {
      const l = lines.slice(); l[2] = next;
      return P.subjectEnterAction((i) => (l[i] === undefined ? null : l[i]), 1, l[1].length, resolve, { date: '2026-10-07' });
    };

    group('学科标题行回车');
    {
      const a = at2(1);
      ok('学科标题行末尾回车 → 算出当天的笔记路径',
        a && a.mode === 'subject' && a.name === SUBJ
          && a.path === 'Subjects/' + SUBJ + '/笔记/2026-10-07.md', a);
    }
    ok('下面还是空的待办框 → 还没插过链接', at2(1).linked === false);
    ok('下面已经有完整路径的链接 → 别重复插',
      withNext('- [[Subjects/' + SUBJ + '/笔记/2026-10-07]]').linked === true);
    ok('链接只写了文件名 + 别名，也算数',
      withNext('- [[2026-10-07|今天的课]]').linked === true);
    ok('下面是不相干的链接 → 不算', withNext('- [[Personal/Diary/2026-10-07]]').linked === false);
    ok('不是学科（### 阅读）→ 不接管', at2(4) === null);
    ok('不是标题行 → 不接管', at2(2) === null);
    ok('光标不在行尾 → 不接管（那是想把标题拆成两行）', at2(1, 5) === null);
    {
      const l = ['### ' + SUBJ + '   '];
      const a = P.subjectEnterAction((i) => (l[i] === undefined ? null : l[i]), 0, l[0].length, resolve, { date: '2026-10-07' });
      ok('标题末尾带空格、光标在最后 → 照样接管', a && a.mode === 'subject', a);
    }
    ok('resolve 说不认识 → 不接管',
      P.subjectEnterAction((i) => (i === 0 ? '### ' + SUBJ : null), 0, 0, () => null, { date: '2026-10-07' }) === null);
  }
  {
    group('学科笔记模板变量');
    const v = { name: 'English', date: '2026-10-07', diary: 'Personal/Diary/2026-10-07.md' };
    ok('{{course}} / {{name}} → 学科名', P.renderSubjectVars('{{course}}·{{name}}', v) === 'English·English');
    ok('{{date:YYYY-MM}} 按给的格式', P.renderSubjectVars('{{date:YYYY-MM}}', v) === '2026-10');
    ok('{{date}} 走默认格式', P.renderSubjectVars('{{date}}', v) === '2026-10-07');
    ok('{{weekday}} 是星期几', P.renderSubjectVars('{{weekday}}', v) === P.weekdayCN('2026-10-07'));
    ok('{{diary}} 是去掉 .md 的双链', P.renderSubjectVars('{{diary}}', v) === '[[Personal/Diary/2026-10-07]]');
    ok('未知变量原样留着（不吃核心模板的变量）', P.renderSubjectVars('{{title}}', v) === '{{title}}');
    ok('取不到值就退到默认值', P.renderSubjectVars('{{course|未命名}}', {}) === '未命名');
  }
  {
    group('目标路径归一化');
    ok('挡掉 ..', P.normTarget('Subjects/../Subjects/English/笔记/a.md') === 'Subjects/English/笔记/a.md');
    ok('末尾补 .md', P.normTarget('Subjects/English/笔记/2026-10-07') === 'Subjects/English/笔记/2026-10-07.md');
  }
  /* --------------------------------- Shift+回车 → 在计划段里再开一个小节 ---- */
  {
    const LINES = [
      '## 今日计划',
      '### Precision Design and Dimensional Inspection',
      '- [ ] 　对几何公差有直观认识',
      '  完成：',
      '### 阅读',
      '- [ ] 　',
      '  完成：',
      '',
      '---',
      '',
      '## 今日复盘',
      '- **去哪（Feed up）**：'
    ];
    const at3 = (ln) => P.sectionEnterAction((i) => (LINES[i] === undefined ? null : LINES[i]), ln, {});

    group('Shift+回车：新开一个小节');
    {
      const a = at3(2);
      ok('光标在待办行 → 插在**当前小节末尾**，不是光标下面',
        a && a.mode === 'insert' && a.line === 3, a);
      ok('给的是一整个小节：### + 一组空占位',
        a && a.text === '\n\n### \n- [ ] \n  完成：', a);
      ok('光标停在 ### 后面等着打学科名',
        a && a.cursor.back === 2 && a.cursor.ch === '### '.length, a);
    }
    ok('光标在「### 阅读」这一行 → 插在它自己那一节的末尾', at3(4).line === 6);
    ok('光标在「## 今日计划」这一行 → 新小节排在整段的最前面', at3(0).line === 0);
    ok('下面撞到 --- 分隔线就停，不会插到分隔线外面去', at3(6).line === 6);
    ok('不在「今日计划」这一段 → 不生效（今日复盘里按没反应）', at3(11) === null);
    {
      const a = P.sectionEnterAction((i) => (LINES[i] === undefined ? null : LINES[i]), 2,
        { titles: ['今日复盘'], label: '结果：' });
      ok('段落名单改了就只在新的段落里生效，且完成行标签跟着走', a === null);
    }
    {
      const only = ['## 今日计划', '### 数学', '- [ ] ', '  完成：'];
      const a = P.sectionEnterAction((i) => (only[i] === undefined ? null : only[i]), 1, {});
      ok('文件末尾也能插（不会越界）', a && a.line === 3 && a.mode === 'insert', a);
    }
  }
  {
    group('新建明天的日记：日期挪动');
    ok('明天', P.shiftDate('2026-10-07', 1) === '2026-10-08', P.shiftDate('2026-10-07', 1));
    ok('昨天（负数）', P.shiftDate('2026-10-07', -1) === '2026-10-06', P.shiftDate('2026-10-07', -1));
    ok('原地不动（0）', P.shiftDate('2026-10-07', 0) === '2026-10-07');
    ok('跨月：10-31 → 11-01', P.shiftDate('2026-10-31', 1) === '2026-11-01', P.shiftDate('2026-10-31', 1));
    ok('跨年：12-31 → 明年 01-01', P.shiftDate('2026-12-31', 1) === '2027-01-01', P.shiftDate('2026-12-31', 1));
    ok('跨回去：01-01 → 去年 12-31', P.shiftDate('2027-01-01', -1) === '2026-12-31');
    ok('闰年：2028-02-28 → 02-29', P.shiftDate('2028-02-28', 1) === '2028-02-29', P.shiftDate('2028-02-28', 1));
    ok('平年：2027-02-28 → 03-01', P.shiftDate('2027-02-28', 1) === '2027-03-01', P.shiftDate('2027-02-28', 1));
    ok('一年后也算得对', P.shiftDate('2026-10-07', 365) === '2027-10-07', P.shiftDate('2026-10-07', 365));
    ok('日期格式不对返回空串（不瞎猜）', P.shiftDate('明天', 1) === '' && P.shiftDate('', 1) === '');
  }
  {
    group('新建明天的日记：核心模板变量');
    const r = (tpl, vars) => P.renderDailyNoteVars(tpl, vars);
    const v = { date: '2026-10-08', time: '09:30', title: '2026-10-08' };

    ok('{{date:YYYY-MM-DD}}', r('date: {{date:YYYY-MM-DD}}', v) === 'date: 2026-10-08');
    ok('{{date:dddd}} 给星期', r('{{date:dddd}}', v) === '星期四', r('{{date:dddd}}', v));
    ok('不带格式的 {{date}} 走默认 YYYY-MM-DD', r('{{date}}', v) === '2026-10-08', r('{{date}}', v));
    ok('{{time}}', r('{{time}}', v) === '09:30');
    ok('{{title}}', r('{{title}}', v) === '2026-10-08');
    ok('冒号两边有空格也认', r('{{ date : YYYY-MM-DD }}', v) === '2026-10-08', r('{{ date : YYYY-MM-DD }}', v));
    // 红线①：认不出来的变量必须原样留下 —— 别的插件的变量不能被吃掉
    ok('未知变量原样保留', r('{{gibberish}}', v) === '{{gibberish}}', r('{{gibberish}}', v));
    ok('核心 {{title}} 之外的写法也保住', r('{{ yay }}', v) === '{{ yay }}', r('{{ yay }}', v));
    ok('空模板不炸', r('', v) === '' && P.renderDailyNoteVars(null, v) === '');
    ok('vars 缺字段时不崩，也不把变量换成空白',
      r('{{date:YYYY}} {{time}}', {}) === '{{date:YYYY}} {{time}}', r('{{date:YYYY}} {{time}}', {}));
  }
  {
    group('新建明天的日记：整份模板端到端');
    const tpl = fs.existsSync(path.join(FIX, '日记模板.md'))
      ? fs.readFileSync(path.join(FIX, '日记模板.md'), 'utf8') : '';
    if (!tpl) {
      ok('fixtures 里得有日记模板', false, '缺 fixtures/日记模板.md');
    } else {
      const out = P.renderDailyNoteVars(tpl, { date: '2026-10-08', time: '21:00', title: '2026-10-08' });
      ok('frontmatter 里的日期换成明天', out.indexOf('date: 2026-10-08') > 0, out.slice(0, 80));
      ok('星期跟着对（2026-10-08 是星期四）', out.indexOf('weekday: 星期四') > 0);
      ok('模板里没留下没换掉的 {{date', out.indexOf('{{date') < 0, out.match(/\{\{[^}]*\}\}/g));
      ok('不确定性：列表那些内容没被改写',
        (out.match(/### /g) || []).length === (tpl.match(/### /g) || []).length);
      ok('一行的数量不变（只换变量，不动版式）',
        out.split(/\r?\n/).length === tpl.split(/\r?\n/).length,
        out.split(/\r?\n/).length + ' vs ' + tpl.split(/\r?\n/).length);
    }
  }
  {
    group('设置迁移');
    const s = P.migrateState({ rules: [] });
    ok('新的四项有默认值，建笔记那个开关默认关（回车留给补骨架）',
      s.subjectEnter === false && s.subjectRoot === 'Subjects'
        && s.subjectPath === 'Subjects/{{name}}/笔记/{{date:YYYY-MM-DD}}.md'
        && s.subjectTemplate === 'Templates/学科笔记模板.md'
        && s.taskEnter === true && s.sectionEnter === true
        && Array.isArray(s.sectionTitles) && s.sectionTitles[0] === '今日计划', s);
    const s2 = P.migrateState({ rules: [], subjectEnter: false, taskEnter: false });
    ok('用户关过的开关不会被 migrate 打开', s2.subjectEnter === false && s2.taskEnter === false);
  }

  console.log('\n' + (fail ? '★ ' + fail + ' 项失败，' + pass + ' 项通过' : '全部通过（' + pass + ' 项）'));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试脚本自己崩了：', e);
  process.exit(2);
});
