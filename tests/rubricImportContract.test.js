jest.mock('../src/services/rubricCompletion.service', () => ({ completeRubric: jest.fn() }));
const { completeRubric } = require('../src/services/rubricCompletion.service');
const parser = require('../src/services/rubricAIParser.service');
const formatter = require('../src/services/rubricAIFormatter.service');
const { validateAssignmentRubricInput } = require('../src/services/assignmentRubric.service');

const rubric = () => ({ title: 'Essay', totalPoints: 100,
  levels: [{ title: 'Strong', maxPoints: 100 }, { title: 'Developing', maxPoints: 60 }],
  criteria: [{ title: 'Ideas', weight: 70, cells: ['Strong ideas', 'Develop ideas'] },
    { title: 'Structure', weight: 30, cells: ['Clear structure', 'Improve structure'] }] });

beforeEach(() => jest.clearAllMocks());

test('legacy spreadsheet templates receive explicit editable weights totaling 100', () => {
  const XLSX = require('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Criteria', 'Strong', 'Developing'], ['Score', 100, 60],
    ['Ideas', 'Strong ideas', 'Develop ideas'], ['Structure', 'Clear', 'Improve'], ['Language', 'Precise', 'Revise']
  ]), 'Rubric');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const value = require('../src/services/rubricExcelTemplateParser.service').parseRubricDesignerFromExcelTemplate({ buffer });
  expect(value.totalPoints).toBe(100);
  expect(value.criteria.map(row => row.weight)).toEqual([34, 33, 33]);
  expect(validateAssignmentRubricInput(value, true)).toEqual([]);
});

test('AI parsing keeps returned criterion weights and total points', async () => {
  completeRubric.mockResolvedValueOnce(rubric());
  const result = await parser.parseRubricTextToJson({ text: 'Uploaded rubric text' });
  expect(result.totalPoints).toBe(100);
  expect(result.criteria.map(row => row.weight)).toEqual([70, 30]);
});

test('structured import keeps weighting without an AI call', async () => {
  const result = await formatter.formatRubricFromTemplateParsed({ parsedRubric: rubric() });
  expect(result.totalPoints).toBe(100);
  expect(result.criteria.map(row => row.weight)).toEqual([70, 30]);
  expect(completeRubric).not.toHaveBeenCalled();
});

test.each([
  value => { value.totalPoints = 50; },
  value => { value.criteria[0].weight = Infinity; },
  value => { value.criteria[0].weight = -1; },
  value => { value.criteria[0].weight = '70'; },
  value => { value.criteria[1].title = value.criteria[0].title; },
  value => { value.levels[1].title = value.levels[0].title; },
  value => { value.levels[1].maxPoints = NaN; },
  value => { value.criteria[0].cells.pop(); },
  value => { value.criteria[0].cells[0] = ''; },
  value => { value.criteria[0] = null; }
])('malformed input is rejected without repair', change => {
  const value = rubric();
  change(value);
  expect(validateAssignmentRubricInput(value, true).length).toBeGreaterThan(0);
});
