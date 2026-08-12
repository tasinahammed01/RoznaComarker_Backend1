module.exports = {
  apps: [
    {
      name: 'RoznaComarker_Backend',
      script: './src/server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_memory_restart: '1G',
      kill_timeout: 45000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 5000
      }
    }
  ]
};
