'use strict';

// Synthetic, test-only benchmark for capitalisation (CAP) and spacing (SPC) detection. No student data.
// Each expected error is [symbol, needle, offsetInNeedle, occurrence]: the error sits at
// text.indexOf(needle, <occurrence>) + offsetInNeedle. A finding detects it when its span covers that character.
// Groups: "error" (labelled errors), "correct" (no CAP/SPC error allowed), "tricky" (reported separately; no labels).

const sentences = [
  { id: 'E1', group: 'error', text: 'my Friend went To school.', expected: [['CAP', 'my', 0], ['CAP', 'Friend', 0], ['CAP', 'To', 0]] },
  { id: 'E2', group: 'error', text: 'yesterday i went home.', expected: [['CAP', 'yesterday', 0], ['CAP', ' i ', 1]] },
  { id: 'E3', group: 'error', text: 'I was tired. then i slept.', expected: [['CAP', 'then', 0], ['CAP', ' i ', 1]] },
  { id: 'E4', group: 'error', text: 'hi , how are you ?', expected: [['CAP', 'hi', 0], ['SPC', ' ,', 0], ['SPC', ' ?', 0]] },
  { id: 'E5', group: 'error', text: 'I bought apples,bananas and pears.', expected: [['SPC', ',b', 0]] },
  { id: 'E6', group: 'error', text: 'It was late.We left.', expected: [['SPC', '.W', 0]] },
  { id: 'E7', group: 'error', text: 'She said : wait ; please !', expected: [['SPC', ' :', 0], ['SPC', ' ;', 0], ['SPC', ' !', 0]] },
  { id: 'E8', group: 'error', text: "i think i'm right.", expected: [['CAP', 'i ', 0], ["CAP", "i'm", 0]] },
  { id: 'E9', group: 'error', text: 'My brother iS tall.', expected: [['CAP', 'iS', 1]] },
  { id: 'E10', group: 'error', text: 'what a day !', expected: [['CAP', 'what', 0], ['SPC', ' !', 0]] },
  { id: 'E11', group: 'error', text: 'Is it true ?Yes.', expected: [['SPC', ' ?', 0], ['SPC', '?Y', 0]] },
  { id: 'E12', group: 'error', text: 'He was happy , but tired.', expected: [['SPC', ' ,', 0]] },
  { id: 'E13', group: 'error', text: 'After lunch i played football.', expected: [['CAP', ' i ', 1]] },
  { id: 'E14', group: 'error', text: 'My Mother cooked dinner for us.', expected: [['CAP', 'Mother', 0]] },
  { id: 'E15', group: 'error', text: 'We visited new york last summer.', expected: [['CAP', 'new', 0], ['CAP', 'york', 0]] },

  { id: 'C1', group: 'correct', text: 'I met Dr. Smith at 3.30 p.m. on Monday.' },
  { id: 'C2', group: 'correct', text: 'The price rose by 2.5% in the U.S. last year.' },
  { id: 'C3', group: 'correct', text: 'Visit www.example.com, then email us.' },
  { id: 'C4', group: 'correct', text: 'NASA and the BBC reported the story.' },
  { id: 'C5', group: 'correct', text: 'She said, "Wait!" and left.' },
  { id: 'C6', group: 'correct', text: 'We read "The Story of an Hour" in class.' },
  { id: 'C7', group: 'correct', text: 'Mrs. Mallard heard the news from Richards.' },
  { id: 'C8', group: 'correct', text: 'Fruits, e.g. apples and pears, are healthy.' },
  { id: 'C9', group: 'correct', text: 'The iPhone and eBay are famous brands.' },
  { id: 'C10', group: 'correct', text: 'I love English, French and Arabic.' },
  { id: 'C11', group: 'correct', text: 'At 10:30 we left; it was late.' },
  { id: 'C12', group: 'correct', text: 'He scored 3,000 points in the game.' },
  { id: 'C13', group: 'correct', text: "Louise Mallard's choices shaped her life." },
  { id: 'C14', group: 'correct', text: 'I told Mother the news.' },
  { id: 'C15', group: 'correct', text: 'Chapter 2: The Storm' },

  { id: 'T1', group: 'tricky', text: 'We went to the Park after school.', note: 'common noun or a named park' },
  { id: 'T2', group: 'tricky', text: 'The weather is NICE today.', note: 'capitals for emphasis' },
  { id: 'T3', group: 'tricky', text: '- first item\n- second item', note: 'list items starting in lowercase' },
  { id: 'T4', group: 'tricky', text: 'Wait ... what ?', note: 'spaced ellipsis and a space before ?' },
  { id: 'T5', group: 'tricky', text: 'OK , fine.', note: 'acronym followed by a space before a comma' },
  { id: 'T6', group: 'tricky', text: 'My Summer Holiday\nwe went to the beach.', note: 'title line without a full stop, then a lowercase line' },
  { id: 'T7', group: 'tricky', text: 'I like this word ,word game.', note: 'handwriting-like comma placement' }
];

const essays = [
  { id: 'ES1', group: 'essay', text: 'My Weekend\n\nlast saturday i went to the park with my Family . we played football and ate sandwiches,then we walked home. It was a great day , and i want to go again next week.',
    expected: [['CAP', 'last', 0], ['CAP', 'saturday', 0], ['CAP', ' i ', 1], ['CAP', 'Family', 0], ['SPC', 'Family .', 6], ['CAP', ' we played', 1],
      ['SPC', ',then', 0], ['SPC', 'day ,', 3], ['CAP', ' i want', 1]] },
  { id: 'ES2', group: 'essay', text: 'Technology has changed our lives in many ways. Today, People use smartphones to talk , study and shop.However, some students spend too much time online. In my opinion, schools should teach students how to use Technology wisely. i believe this will help them in the Future.',
    expected: [['CAP', 'People', 0], ['SPC', 'talk ,', 4], ['SPC', 'shop.However', 4], ['CAP', 'use Technology', 4], ['CAP', 'i believe', 0], ['CAP', 'Future', 0]] },
  { id: 'ES3', group: 'essay', text: 'Dear Sara,\n\nThank you for your letter. i was very happy to hear from you ! My new school is big and the Teachers are kind. we have English, Maths and Science every day. At 8:30 a.m. we start our first lesson.\n\nBest wishes,\nAli',
    expected: [['CAP', 'i was', 0], ['SPC', 'you !', 3], ['CAP', 'Teachers', 0], ['CAP', 'we have', 0]] },
  { id: 'ES4', group: 'essay', text: 'Pollution is a big problem in many cities.Cars and factories make the air dirty . Many people,especially children, get sick. Every Family should plant more trees and use buses. If we work together , we can make our cities cleaner and Healthier.',
    expected: [['SPC', 'cities.Cars', 6], ['SPC', 'dirty .', 5], ['SPC', 'people,especially', 6], ['CAP', 'Family', 0], ['SPC', 'together ,', 8], ['CAP', 'Healthier', 0]] },
  { id: 'ES5', group: 'essay', text: 'When i was ten years old, my Grandfather gave me an old book. the book was about a brave girl who sailed across the sea. I read it every night before bed. Even now, I still remember her words : never give up.',
    expected: [['CAP', 'When i', 5], ['CAP', 'Grandfather', 0], ['CAP', 'the book', 0], ['SPC', 'words :', 5]] },
  { id: 'ES6', group: 'essay', text: 'Should students wear uniforms? Some people think uniforms are boring , but I disagree. Uniforms save time in the morning and they make everyone feel Equal. Also,they are cheaper than buying many clothes. In conclusion, i think uniforms are a good idea for most schools.',
    expected: [['SPC', 'boring ,', 6], ['CAP', 'Equal', 0], ['SPC', 'Also,they', 4], ['CAP', ' i think', 1]] },
  { id: 'ES7', group: 'essay', text: 'Last summer, my family visited London for one week. We saw Big Ben, the London Eye and the British Museum. My brother were very excited because he love history. On the last day, we ate fish and chips near the River Thames. It was the best holiday of my life, and I hope we can go back in 2027.',
    expected: [] },
  { id: 'ES8', group: 'essay', text: 'My favourite season is Winter because i love snow. In december we build snowmen and drink hot chocolate . My sister and i go skating every Saturday.It is cold , but it is fun !',
    expected: [['CAP', 'Winter', 0], ['CAP', ' i love', 1], ['CAP', 'december', 0], ['SPC', 'chocolate .', 9], ['CAP', ' i go', 1],
      ['SPC', 'Saturday.It', 8], ['SPC', 'cold ,', 4], ['SPC', 'fun !', 3]] }
];

/** Expected errors with absolute character anchors. */
function anchors(item) {
  return (item.expected || []).map(([symbol, needle, offset, occurrence = 0]) => {
    let at = -1;
    for (let seen = 0; seen <= occurrence; seen += 1) at = item.text.indexOf(needle, at + 1);
    return { symbol, needle, anchor: at < 0 ? -1 : at + offset };
  });
}

module.exports = { sentences, essays, anchors };
