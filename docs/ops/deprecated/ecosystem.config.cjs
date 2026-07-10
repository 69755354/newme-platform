module.exports = {
  apps: [{
    name: 'newme-platform',
    script: 'npm',
    args: 'start',
    cwd: '/home/ubuntu/newme-platform',

    // === 环境 ===
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },

    // === 崩溃保护 ===
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',          // 10秒内崩了才算"不稳定"
    restart_delay: 4000,
    exp_backoff_restart_delay: 100,  // 指数退避: 100ms→150ms→...→15s
    stop_exit_codes: [0],       // 正常退出不重启

    // === 优雅启停 ===
    listen_timeout: 15000,
    kill_timeout: 10000,

    // === 自愈 ===
    max_memory_restart: '500M',  // 内存超500M自动重启
    cron_restart: '0 4 * * *',   // 每天凌晨4点清理

    // === 日志 ===
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
