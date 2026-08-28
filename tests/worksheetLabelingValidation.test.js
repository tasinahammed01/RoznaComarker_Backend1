const { buildLabelingImageQuery, validateLabelingActivity } = require('../src/services/worksheetLabelingValidation.service');

function solar(overrides = {}) {
  return {
    title: 'Label the Solar System Image',
    data: {
      labels: ['Sun', 'Mercury', 'Venus', 'Earth'].map((text, index) => ({ id: `l${index}`, targetId: `l${index}`, text, x: 15 + index * 20, y: 50 })),
      ...overrides,
    },
  };
}

describe('worksheet image-labeling validation', () => {
  test('rejects a topic/image mismatch', () => expect(validateLabelingActivity(solar(), { topic: 'Solar System', imagePurpose: 'forest trees and woodland', targetCount: 4 }).errors).toContain('IMAGE_TOPIC_MISMATCH'));
  test('rejects generic stock photography even when its topic is related', () => expect(validateLabelingActivity(solar(), { topic: 'Solar System', imagePurpose: 'solar system space photo', targetCount: 4 }).errors).toContain('UNSUITABLE_IMAGE_TYPE'));
  test('rejects labels from another topic', () => expect(validateLabelingActivity(solar({ labels: [{ id: 'x', targetId: 'x', text: 'Roots', x: 50, y: 50 }] }), { topic: 'Solar System', imagePurpose: 'solar system diagram', targetCount: 1 }).errors).toContain('LABEL_TOPIC_MISMATCH'));
  test('rejects target count mismatch', () => expect(validateLabelingActivity(solar(), { topic: 'Solar System', imagePurpose: 'solar system diagram', targetCount: 3 }).errors).toContain('TARGET_COUNT_MISMATCH'));
  test('rejects invalid coordinates', () => expect(validateLabelingActivity(solar({ labels: [{ id: 'sun', targetId: 'sun', text: 'Sun', x: 101, y: 50 }] }), { topic: 'Solar System', imagePurpose: 'solar system diagram', targetCount: 1 }).errors).toContain('INVALID_COORDINATES'));
  test('accepts a coherent diagram activity', () => expect(validateLabelingActivity(solar(), { topic: 'Solar System', imagePurpose: 'solar system educational diagram with planets', targetCount: 4 })).toEqual({ valid: true, errors: [] }));
  test('prefers a diagram query containing title and labels', () => expect(buildLabelingImageQuery(solar(), 'Space').toLowerCase()).toContain('educational diagram label the solar system image sun mercury'));
});
