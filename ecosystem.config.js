module.exports = {
  apps: [
    {
      name: 'RoznaComarker_Backend',
      script: './src/server.js',
      cwd: 'D:\\Client Project Fiverr\\1st project\\ProjectRozna\\backend',
      watch: false,
      env_file: '.env',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};