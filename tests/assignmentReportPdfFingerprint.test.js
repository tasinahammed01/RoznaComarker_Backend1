'use strict';
// The assignment report PDF must not change the feedback PDF: none of the 18 files that feed the feedback-PDF cache
// rendererFingerprint may change, and the fingerprint itself must equal the value recorded on base 846dfc04 (before Stage 3).
// If a later task changes one of these files on purpose, that task updates this table with a justification.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE_RENDERER_FINGERPRINT = '094d204ac7dcea240e3b5f179cc7ef2e40684dcf4142bf1dfbcc4793dc18f488';
const BASE_FILES = [
  ['../modules/submissionFeedbackPdfGenerator.js', '84cce4f6ea2bfec4bbd38191414300691e1ce3a0e29535e8581723f444b40061'],
  ['../pdf/submissionFeedbackReportTemplate.js', '84d0449774e82e9c3b9720d389fc13c13a6539301f7a7680376b0361e6b1f8d8'],
  ['../pdf/submittedImageAnnotationLayout.js', '3b4274fc9316595e1e0ed9ea1cc7e6bfe2df87178e586f17fcceb1378c024874'],
  ['../pdf/assets/rubrilo-logo-horizontal-fullcolor@512w.png', '9aab5e0500c20b4011b06a26cf244552b4fa37dd4924d1f84c8a2ae8163b0748'],
  ['../constants/assessmentCategories.js', '69858dc3e039e09267e60708f4962b4fc908b3f1f64e7cc5f1de383e594f2de9'],
  ['../pdf/websiteAnnotationPresentation.js', 'cf007ceef6c47294898917238658942730c6562e1e76376656033b573e95bbf4'],
  ['../pdf/websiteAnnotationRules.generated.js', '647b7140307aed8512325ea2429fd705d104677e2af81c5fb5745ad31bbec643'],
  ['../pdf/sample/submissionFeedbackReportViewModel.js', 'fb0a78fd112b63f47fe05053a41fb8773ace57f619631b62a259fb869400e356'],
  ['./submissionFeedbackReport.service.js', '8297d1b11ee13780ed4d0c4281ad3e376584659d231c81d7e24f20bc3305583f'],
  ['./correctionLegendResolver.service.js', '178b715a195a2a1de076ce0766a3630ab12bbc5b1a1967fb87f309917d718b56'],
  ['./canonicalCorrectionRender.service.js', 'f246dbd7778c99ff1dbeb452b4f533e595e8669e1e3501931b57dda203ec81b2'],
  ['./canonicalCorrectionResponse.service.js', '4e4020571d4bd295a0230340d30d6bdb8eb5ce4454aa43f909ba91fe00ee6453'],
  ['./teacherComments.service.js', '814d74ffb48064df08935aed6518a764b2c86968bf1dd070bd8993547ed37334'],
  ['./teacherAnnotation.service.js', '8b1f96af371c2b3c6a0f920e70298c9d0fd8533269e72dba9e91b86c4db615f1'],
  ['./studentCorrectionView.service.js', '1160ff75700a820f6e7e97b0d8490be5b0e5c3387131f43269fcbcadb408402d'],
  ['./annotationAnchor.service.js', '14683b9610846cc25d2ea4245d3fcc682c18c9432e8194d976aaa3ac6fd833cc'],
  ['../utils/ocrTranscriptNormalizer.js', '95ff3551bd104b38d6eb3fb9aba71b1b7db393f0e52905e1a2e97c589427e666'],
  ['../utils/legacyStudentSource.js', '701e4730fc07477daaf35f9b84652e4a194d416e08958d43423b234a80924a59']
];
const SERVICES = path.join(__dirname, '..', 'src', 'services');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(SERVICES, file))).digest('hex');

describe('feedback PDF cache fingerprint is unchanged by the assignment report', () => {
  test('the fingerprint reads exactly these 18 files', () => {
    const source = fs.readFileSync(path.join(SERVICES, 'submissionFeedbackPdfCache.service.js'), 'utf8');
    const block = source.slice(source.indexOf('const rendererFingerprint'), source.indexOf('const annotationFingerprint'));
    expect([...block.matchAll(/'(\.\.?\/[^']+)'/g)].map(m => m[1])).toEqual(BASE_FILES.map(([file]) => file));
  });

  test.each(BASE_FILES)('%s is byte-identical to base', (file, expected) => {
    expect(sha(file)).toBe(expected);
  });

  test('rendererFingerprint equals the base value', () => {
    expect(require('../src/services/submissionFeedbackPdfCache.service').rendererFingerprint).toBe(BASE_RENDERER_FINGERPRINT);
  });

  test('the assignment report modules do not change any fingerprinted file when loaded', () => {
    require('../src/pdf/assignmentReportTemplate');
    require('../src/modules/assignmentReportPdfGenerator');
    require('../src/controllers/assignmentReportPdf.controller');
    for (const [file, expected] of BASE_FILES) expect(sha(file)).toBe(expected);
  });
});
