function getBucketName() {
  throw new Error('S3 storage has been removed');
}

function getS3Client() {
  throw new Error('S3 storage has been removed');
}

module.exports = {
  getS3Client,
  getBucketName
};
