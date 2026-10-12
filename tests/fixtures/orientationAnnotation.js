function annotation(angles = [0, 0, 0, 0, 0, 0]) {
  return { pages: [{ blocks: [{ paragraphs: [{ words: angles.map((angle, index) => {
    const radians = angle * Math.PI / 180;
    return { boundingBox: { vertices: [[0, 0], [60, 0], [60, 15], [0, 15]].map(([x, y]) => ({
      x: 200 + index * 80 + x * Math.cos(radians) - y * Math.sin(radians),
      y: 200 + x * Math.sin(radians) + y * Math.cos(radians),
    })) } };
  }) }] }] }] };
}
module.exports = { annotation };
