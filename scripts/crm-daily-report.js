const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/home/ubuntu/newme-platform/.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const now = new Date();
  // Dubai time: UTC+4 — use local methods, not toISOString which always returns UTC
  const dubaiNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const todayStr = dubaiNow.toISOString().slice(0, 10);
  const dubaiTimeStr = dubaiNow.toISOString().slice(11, 16);
  // todayStart: midnight Dubai = 20:00 UTC previous day
  const todayStart = new Date(todayStr + 'T00:00:00+04:00').toISOString();
  
  // Profiles
  const { data: profiles } = await supabase.from('profiles').select('id, full_name, role');
  const profileMap = {};
  profiles.forEach(p => { profileMap[p.id] = p; });

  // Today's sessions
  const { data: sessions } = await supabase.from('user_session_daily')
    .select('*').eq('session_date', todayStr).order('last_active', { ascending: false });

  // Today's activities
  const { data: activities } = await supabase.from('activity_logs')
    .select('*').gte('created_at', todayStart).order('created_at', { ascending: false }).limit(100);

  // Business activities from old table
  const { data: bizActivities } = await supabase.from('activities')
    .select('*').gte('created_at', todayStart).order('created_at', { ascending: false }).limit(100);

  // Leads
  const { data: leads } = await supabase.from('leads').select('stage, source, assigned_to');

  // Recent sessions for inactive detection
  const { data: allSessions } = await supabase.from('user_session_daily')
    .select('*').order('session_date', { ascending: false }).limit(100);

  // Build report
  const report = [];
  
  // Header
  report.push('📊 **NewMe CRM Daily Activity Report / CRM每日活动报告**');
  report.push('🗓 ' + todayStr + ' | ⏰ ' + dubaiTimeStr + ' Dubai Time');
  report.push('');
  report.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  report.push('');
  
  // 1. Login Status
  report.push('🔐 **1. Login Status / 登录状态**');
  report.push('');
  
  const loggedInToday = new Set();
  if (sessions) sessions.forEach(s => loggedInToday.add(s.user_id));
  
  // Map profiles to last session
  const lastSessionMap = {};
  if (allSessions) {
    allSessions.forEach(s => {
      if (!lastSessionMap[s.user_id] || s.session_date > lastSessionMap[s.user_id].date) {
        lastSessionMap[s.user_id] = { date: s.session_date, first_login: s.first_login, last_active: s.last_active };
      }
    });
  }
  
  let activeCount = 0, inactiveCount = 0;
  profiles.forEach(p => {
    const lastSess = lastSessionMap[p.id];
    const isActive = loggedInToday.has(p.id);
    if (isActive) activeCount++;
    else inactiveCount++;
    
    const emoji = isActive ? '🟢' : '🟡';
    const loginTime = lastSess ? new Date(lastSess.last_active).toISOString().slice(11, 16) + ' Dubai' : 'No data';
    const dateInfo = lastSess ? lastSess.date : 'N/A';
    
    report.push(`• **${p.full_name}** (${p.role}) — ${loginTime}`);
    if (isActive) {
      report.push(`  今日登录 | ${dateInfo}`);
    } else {
      report.push(`  未活跃 | 上次: ${dateInfo}`);
    }
  });
  
  report.push('');
  report.push(`🟢 Active Today / 今日活跃: ${activeCount}/${profiles.length}`);
  report.push(`🟡 Inactive / 未活跃: ${inactiveCount}/${profiles.length}`);
  report.push('');
  
  // 2. Today's Operations
  report.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  report.push('');
  report.push('📋 **2. Today\'s Operations / 今日操作**');
  report.push('');
  
  const activityCount = activities ? activities.length : 0;
  const bizCount = bizActivities ? bizActivities.length : 0;
  const totalOps = activityCount + bizCount;
  
  report.push(`Total / 总操作: ${totalOps}`);
  report.push(`• Page Views 页面浏览: ${activityCount}`);
  report.push(`• Business Actions 业务操作: ${bizCount}`);
  report.push('');
  
  if (bizActivities && bizActivities.length > 0) {
    const bizTypes = {};
    const bizUsers = {};
    bizActivities.forEach(a => {
      bizTypes[a.activity_type] = (bizTypes[a.activity_type] || 0) + 1;
      const userName = profileMap[a.created_by] ? profileMap[a.created_by].full_name : 'Unknown';
      bizUsers[userName] = (bizUsers[userName] || 0) + 1;
    });
    report.push('Business Operations / 业务操作:');
    Object.entries(bizTypes).forEach(([k, v]) => report.push(`  • ${k}: ${v}`));
    report.push('');
    report.push('Operators / 操作人员:');
    Object.entries(bizUsers).forEach(([k, v]) => report.push(`  • ${k}: ${v}`));
  }
  
  // Last biz activity for context
  if (bizActivities && bizActivities.length > 0) {
    report.push('');
    report.push('Recent / 最近操作:');
    bizActivities.slice(0, 5).forEach(a => {
      const time = new Date(a.created_at).toISOString().slice(11, 16);
      const by = profileMap[a.created_by] ? profileMap[a.created_by].full_name : '?';
      report.push(`  ${time} | ${a.activity_type} | ${by}`);
    });
  }
  
  report.push('');
  
  // 3. Lead Overview
  report.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  report.push('');
  report.push('📊 **3. Lead Overview / 线索概览**');
  report.push('');
  
  const totalLeads = leads ? leads.length : 0;
  report.push(`Total / 总数: **${totalLeads}**`);
  report.push('');
  
  if (leads) {
    const stages = {};
    const sources = {};
    const assignees = {};
    leads.forEach(l => {
      stages[l.stage || 'unknown'] = (stages[l.stage || 'unknown'] || 0) + 1;
      sources[l.source || 'unknown'] = (sources[l.source || 'unknown'] || 0) + 1;
      const name = profileMap[l.assigned_to] ? profileMap[l.assigned_to].full_name : 'Unassigned';
      assignees[name] = (assignees[name] || 0) + 1;
    });
    
    report.push('Stage / 阶段:');
    Object.entries(stages).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => report.push(`  • ${k}: ${v}`));
    report.push('');
    
    report.push('Source / 来源:');
    Object.entries(sources).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
      const pct = totalLeads > 0 ? Math.round(v/totalLeads*100) : 0;
      report.push(`  • ${k}: ${v} (${pct}%)`);
    });
    report.push('');
    
    report.push('Assignment / 分配:');
    Object.entries(assignees).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => report.push(`  • ${k}: ${v}`));
  }
  
  report.push('');
  report.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  report.push('');
  
  // 4. Alerts
  report.push('⚠️ **4. Alerts / 预警**');
  report.push('');
  
  // Inactive users > 1 day
  const alerts = [];
  profiles.forEach(p => {
    const lastSess = lastSessionMap[p.id];
    if (!lastSess || lastSess.date < todayStr) {
      const daysAgo = lastSess ? Math.floor((new Date(todayStr) - new Date(lastSess.date)) / 86400000) : 999;
      alerts.push(`🟡 ${p.full_name} inactive ${daysAgo}+ days / ${daysAgo}+天未活跃`);
    }
  });
  
  // User tracking gap
  if (activityCount > 0 && bizCount === 0) {
    alerts.push('🔴 No business operations logged — only page views / 仅有页面浏览无业务操作');
  }
  
  // Lead imbalance
  if (leads) {
    const assignCounts = {};
    leads.forEach(l => {
      const name = profileMap[l.assigned_to] ? profileMap[l.assigned_to].full_name : 'Unassigned';
      assignCounts[name] = (assignCounts[name] || 0) + 1;
    });
    const maxAssigned = Math.max(...Object.values(assignCounts));
    if (maxAssigned > totalLeads * 0.8 && Object.keys(assignCounts).length > 1) {
      alerts.push('🟡 Lead imbalance: one person carries >80% / 线索分配不均');
    }
  }
  
  if (alerts.length === 0) {
    report.push('✅ No alerts / 无预警');
  } else {
    alerts.forEach(a => report.push(a));
  }
  
  report.push('');
  report.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  report.push('_Auto-generated by NewMe Hermes / Hermes自动生成_');

  console.log(report.join('\n'));
  return report.join('\n');
}

main().catch(e => console.error('FATAL:', e.message));
