'use strict';
// Real human speech, 44.6 s, deliberate um/uh (speaking-A). Expected: passes the guard.
// OpenRouter /audio/transcriptions, model elevenlabs/scribe-v2, response_format verbose_json, timestamp_granularities word+segment, language en,
// recorded 2026-11-17. Redacted: generation id, headers and request metadata removed; everything else as returned (words compacted to
// [word, start, end, confidence] and expanded below). Synthetic or the developer's own voice: no student data.
const WORDS = [
  ["Um,",0.12,0.24,0.9999683708817015],["my",0.56,0.78,0.9999808076722754],["favorite",0.84,1.14,0.9996083125416166],["place",1.16,1.36,0.9999998807907247],["in",1.4,1.46,0.9999984502816872],["the",1.48,1.54,0.9999998807907247],
  ["world",1.58,1.78,0.999994397195003],["is",1.82,1.92,1],["my",1.98,2.12,0.9999998807907247],["grandmother's",2.18,2.74,0.9982104949688233],["village.",2.78,3.14,0.9999880197858871],["It",3.58,3.64,0.9999988079084972],
  ["is",3.66,3.74,1],["a",3.8,3.88,0.9999990463265931],["small",3.98,4.18,0.9999998807907247],["place,",4.3,4.62,0.99999821187075],["uh,",5.06,5.18,0.9999996423722735],["near",5.34,5.46,0.9999996423722521],
  ["a",5.52,5.54,1],["big",5.72,5.86,0.9999998807907247],["river.",5.94,6.22,0.9999859734144406],["Every",7.36,7.54,0.9999953508594287],["summer,",7.66,7.98,0.999997922357204],["um,",8.08,8.28,0.9999965429471894],
  ["I",8.74,8.8,0.9999998807907247],["go",8.84,8.96,1],["there",9,9.14,1],["with",9.18,9.3,1],["my",9.34,9.48,1],["cousins.",9.52,9.98,0.9999919238316778],
  ["We",10.68,10.8,0.9999994039539004],["wake",10.84,11,0.9999985694905718],["up",11.06,11.18,1],["early",11.22,11.54,0.9999998807907247],["and,",11.6,11.72,0.9989200297185719],["uh,",12.06,12.12,0.9999983310732338],
  ["we",12.52,12.62,0.9999992847447459],["walk",12.66,12.84,0.9999996423722521],["to",12.88,12.94,1],["the",12.98,13.08,0.9999997615814777],["field",13.14,13.38,0.9999998807907247],["behind",13.4,13.66,0.9999998807907247],
  ["the",13.7,13.78,1],["house.",13.84,14.26,0.9999370712816896],["The",14.88,14.96,0.9999998807907247],["air",15,15.1,1],["is",15.14,15.32,1],["fresh",15.38,15.76,0.9999995231630692],
  ["and,",15.84,16,0.9997070807768805],["um,",16.42,16.54,0.9999701596528858],["everything",17.18,17.48,0.9999986886995842],["feels",17.58,17.88,0.9999988079084972],["very",17.92,18.08,1],["quiet.",18.24,18.76,0.9999980727870178],
  ["In",19.84,19.9,0.9999983310727032],["the",19.94,20,1],["afternoon,",20.08,20.54,0.9998295473866884],["we",20.62,20.74,1],["swim",20.78,20.96,1],["in",20.98,21.04,1],
  ["the",21.08,21.16,1],["river",21.2,21.44,0.9999994039539004],["and,",21.5,21.82,0.9893864310151885],["uh,",21.88,21.92,0.9999939601003056],["my",22.16,22.3,0.9999995231630692],["grandmother",22.34,22.82,0.999998927117538],
  ["cooks",22.86,23.12,0.9999983310727032],["fish",23.16,23.34,0.9999997615814777],["and",23.36,23.46,0.9999985694905718],["rice",23.52,23.76,0.9999996423722521],["for",23.8,23.9,0.9999997615814777],["us.",23.96,24.12,0.999996860841824],
  ["I",24.82,24.9,0.9999998807907247],["really",24.94,25.18,1],["love,",25.22,25.46,0.999991440988633],["um,",25.86,26,0.9999991655358897],["the",26.46,26.56,0.9999996423722521],["taste",26.62,26.82,0.9999994039539004],
  ["of",26.86,26.92,1],["her",26.94,27,0.9999997615814777],["food.",27.14,27.46,0.9999996662143178],["In",28.54,28.6,0.9999992847447459],["the",28.64,28.7,1],["evening,",28.76,29.04,0.9998334992074196],
  ["we",29.12,29.28,0.9999998807907247],["sit",29.34,29.46,0.9999998807907247],["outside",29.52,30,1],["and,",30.04,30.4,0.9999776785652266],["uh,",30.48,30.52,0.9999994834267538],["listen",30.76,31,0.9999995231630692],
  ["to",31.04,31.1,1],["old",31.14,31.3,1],["stories.",31.44,31.96,0.99998606776918],["I",32.28,32.34,1],["think,",32.36,32.659,0.9999994834273411],["um,",32.8,32.96,0.9999959469160207],
  ["that",33.54,33.66,0.9999998807907247],["place",33.7,33.94,0.9999998807907247],["makes",33.98,34.16,0.9999974966112362],["me",34.2,34.3,0.9999997615814777],["feel",34.34,34.46,1],["calm",34.6,34.94,1],
  ["and,",34.98,35.2,0.999968978005894],["uh,",35.28,35.36,0.999999523163126],["happy.",35.64,36,0.9999538932322845],["When",36.98,37.08,0.9999979734461775],["I",37.14,37.18,0.9999997615814777],["am",37.2,37.34,0.9999998807907247],
  ["stressed",37.4,37.66,0.9999958276922101],["in",37.68,37.74,0.9999996423722521],["the",37.78,37.88,1],["city,",37.92,38.1,0.999901537998179],["I",38.24,38.32,0.9999997615814777],["close",38.36,38.6,0.9999998807907247],
  ["my",38.68,38.82,1],["eyes",38.9,39.14,1],["and,",39.16,39.3,0.9999627782955768],["um,",39.58,39.76,0.9999965429535606],["imagine",40.18,40.56,0.9999905825550351],["that",40.6,40.74,1],
  ["river.",40.8,41.04,0.9999915164903953],["One",42,42.12,0.9999985694905718],["day,",42.18,42.28,0.9978486870295656],["I",42.38,42.44,0.9999998807907247],["want",42.46,42.56,0.9999687681413515],["to,",42.58,42.78,0.9999972979373347],
  ["uh,",42.88,43,0.999998887381341],["build",43.14,43.28,0.999998927117538],["a",43.32,43.4,1],["small",43.46,43.68,1],["house",43.78,44.04,1],["there.",44.08,44.26,0.9165050446849532]
];
module.exports = {
  text: "Um, my favorite place in the world is my grandmother's village. It is a small place, uh, near a big river. Every summer, um, I go there with my cousins. We wake up early and, uh, we walk to the field behind the house. The air is fresh and, um, everything feels very quiet. In the afternoon, we swim in the river and, uh, my grandmother cooks fish and rice for us. I really love, um, the taste of her food. In the evening, we sit outside and, uh, listen to old stories. I think, um, that place makes me feel calm and, uh, happy. When I am stressed in the city, I close my eyes and, um, imagine that river. One day, I want to, uh, build a small house there.",
  language: "eng",
  language_confidence: 1,
  duration: 44.617125,
  segments: [{ id: 0, start: 0, end: 44.617125, text: "Um, my favorite place in the world is my grandmother's village. It is a small place, uh, near a big river. Every summer, um, I go there with my cousins. We wake up early and, uh, we walk to the field behind the house. The air is fresh and, um, everything feels very quiet. In the afternoon, we swim in the river and, uh, my grandmother cooks fish and rice for us. I really love, um, the taste of her food. In the evening, we sit outside and, uh, listen to old stories. I think, um, that place makes me feel calm and, uh, happy. When I am stressed in the city, I close my eyes and, um, imagine that river. One day, I want to, uh, build a small house there." }],
  words: WORDS.map(([word, start, end, confidence]) => ({ word, start, end, confidence })),
  usage: { seconds: 44.617125, cost: 0.0027266020833328374 }
};
