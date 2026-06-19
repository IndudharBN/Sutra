// pm2 process config — run from project root.
//
// NOTE: the daemon is NO LONGER managed by pm2. pm2's god daemon proved
// unstable on this machine (it kept dying and orphaning the daemon -> split
// brain -> "Daemon offline"). The daemon now runs via RUN_DAEMON.bat, a plain
// self-restarting wrapper window with no god-daemon dependency (the memory leak
// that justified pm2's recycle is fixed in code). pm2 here manages only the UI.
//
// Usage: pm2 start ecosystem.config.cjs --only sutra-ui
//        pm2 logs sutra-ui / pm2 status / pm2 save

'use strict';

module.exports = {
  apps: [
    {
      name: 'sutra-ui',
      script: './node_modules/vite/bin/vite.js',
      args: '--port=3006 --host=0.0.0.0',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      out_file: './logs/ui-out.log',
      error_file: './logs/ui-error.log',
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
