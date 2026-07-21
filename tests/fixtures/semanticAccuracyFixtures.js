'use strict';

// Sanitized, synthetic fixtures for explicit semantic model benchmarking. The
// labels are intentionally symbol-level; live responses must still pass exact
// quotation, hash, category, confidence, duplicate, and offset validation.
module.exports = [
  { id: 'weak_conclusion', text: 'Public transport can reduce traffic and pollution. It also helps people reach work without owning a car. That is all I know about transport.', expected: ['CONC'] },
  { id: 'idea_development', text: 'School gardens are useful. They are good for students. They make school better.', expected: ['DEV', 'SD'] },
  { id: 'irrelevant_content', text: 'The assignment asks how recycling helps cities. Recycling reduces landfill waste. My favorite sport is badminton and my racket is blue. Cities can reuse valuable materials.', expected: ['REL'] },
  { id: 'supporting_details', text: 'Libraries improve communities because they provide many benefits. These benefits are important for everyone.', expected: ['SD'] },
  { id: 'poor_cohesion', text: 'Remote work reduces commuting time. Employees can focus in quiet spaces. However, this sentence does not contrast the previous point. Teams also need clear communication.', expected: ['CO'] },
  { id: 'paragraph_unity', text: 'Healthy lunches help students concentrate. Fresh fruit provides steady energy. The school football team won on Tuesday. Balanced meals can support learning.', expected: ['PU'] },
  { id: 'repetition', text: 'The program is useful because useful lessons give useful skills, and those useful skills are useful at work.', expected: ['REP'] },
  { id: 'weak_word_choice', text: 'The policy did a big change to the local economy and made many outcomes happen.', expected: ['WC'] },
  { id: 'wrong_word_form', text: 'The proposal offers a benefit solution and creates economy opportunities.', expected: ['WF'] },
  { id: 'collocation', text: 'Students can make strong attention during lessons and take a decision about their goals.', expected: ['COL'] },
  { id: 'strong_zero', text: 'Urban trees reduce summer heat by shading streets and releasing moisture. A city study can compare temperatures on similar blocks with and without mature trees. Although planting and maintenance require funding, lower cooling demand and safer walking conditions provide measurable public value. Therefore, cities should prioritize trees in neighborhoods with the highest heat exposure.', expected: [] },
  { id: 'grammar_only', text: 'Students learns quickly when teachers gives clear examples. The central claim is supported by a classroom survey and a relevant comparison. In conclusion, the evidence supports the proposed teaching approach.', expected: [] },
  { id: 'multi_page', text: 'Community clinics improve access to preventive care. Local appointments reduce travel time and help residents seek advice earlier.\n\nClinics also need stable staffing and referral systems. With those safeguards, neighborhood services can improve access without isolating patients from specialist care.', expected: [], pageBreaks: [122] },
  { id: 'repeated_quotation', text: 'Public parks matter. Public parks matter because they support exercise. The phrase public parks matter needs evidence each time it appears.', expected: ['REP'] }
];
