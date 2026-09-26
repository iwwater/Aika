// A finite Chinese relation vocabulary for candidate recall, not an employer extractor.
// Unknown syntax is left to the existing lexical path. Never rewrite the stored evidence.
const current = '(?:现在|目前|当前|这周|本周|最近|刚刚|刚|已经|已|正|正在)';
const place = '(?:哪里|哪儿|哪|哪家(?:公司|单位|企业|机构)?|哪个(?:公司|单位|企业|机构))';
const questionEnd = '(?:呢|来着)?[？?]?$';
const employmentQuestions = [
  new RegExp(`^(?:我|用户)${current}{0,2}在?${place}(?:工作|上班|任职|就职)${questionEnd}`, 'u'),
  new RegExp(`^(?:我|用户)${current}{0,2}(?:就职|任职|供职)于${place}${questionEnd}`, 'u'),
  new RegExp(`^(?:我|用户)${current}{0,2}的(?:工作单位|任职单位|雇主)是${place}${questionEnd}`, 'u'),
];

// Check the whole record, including qualifiers after an otherwise positive first clause.
// This deliberately prefers missed expansion to flattening negated, past or future facts.
const qualified = /不|没|未|无业|失业|离职|辞职|退休|曾|以前|之前|过去|原来|当时|去年|上周|上月|前天|昨天|后来|未来|计划|打算|考虑|准备|希望|想|将|下周|下月|明年|明天|后天|如果|假如|要是|假设|可能|也许|或许|据说|听说|谣言|虚构|玩笑|面试|参观|参访|父亲|母亲|爸爸|妈妈|朋友|同事|邻居|丈夫|妻子|哥哥|姐姐|弟弟|妹妹|他|她/u;
const subject = `^(?:用户|我)${current}{0,3}`;
const organization = '[\\p{L}\\p{N}·&（）() -]{1,40}';
const workplace = `${organization}(?:公司|企业|机构|单位|学校|医院|研究所|研究院|事务所|银行|工作室|团队)`;
// Explicit workplace + occupational predicate; merely doing an arbitrary activity at a place
// (e.g. visiting or doing exercises) is not enough to join this finite candidate set.
const occupation = '[\\p{L}\\p{N}]{0,12}(?:设计|研发|开发|研究|运营|销售|客服|财务|行政|人事|采购|教学|管理|工程师|设计师|经理|教师|会计|编辑)(?:工作)?';
const clauseEnd = '(?:[，,。；;！!？?]|$)';
const employmentStatements = [
  new RegExp(`${subject}(?:入职|就职于|任职于|供职于|受雇于)${organization}${clauseEnd}`, 'u'),
  new RegExp(`${subject}在${organization}(?:工作|上班|任职|就职)${clauseEnd}`, 'u'),
  new RegExp(`${subject}在${workplace}(?:做|从事|负责|担任)${occupation}${clauseEnd}`, 'u'),
];

export function asksCurrentEmployment(query: string): boolean {
  return employmentQuestions.some(pattern => pattern.test(query.trim()));
}

export function isEmploymentCandidate(text: string): boolean {
  return !qualified.test(text) && employmentStatements.some(pattern => pattern.test(text.trim()));
}
