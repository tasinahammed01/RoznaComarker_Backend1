const crypto = require('crypto');

const JOIN_CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const JOIN_CODE_DIGITS = '23456789';
const JOIN_CODE_ALPHABET = `${JOIN_CODE_LETTERS}${JOIN_CODE_DIGITS}`;

function randomCharacter(characters) {
  return characters[crypto.randomInt(0, characters.length)];
}

function generateShortJoinCode() {
  const characters = [
    randomCharacter(JOIN_CODE_LETTERS),
    randomCharacter(JOIN_CODE_DIGITS)
  ];

  while (characters.length < 6) {
    characters.push(randomCharacter(JOIN_CODE_ALPHABET));
  }

  for (let i = characters.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }

  return characters.join('');
}

module.exports = {
  JOIN_CODE_ALPHABET,
  generateShortJoinCode
};
