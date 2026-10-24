"""Real PostgreSQL sessions on an isolated, schema-replayed database only."""
import concurrent.futures,hashlib,json,os,pathlib,re,subprocess,time
assert os.environ.get('PGDATABASE')=='newme_ads_atomic_test','isolated database required'
ROOT=pathlib.Path(__file__).resolve().parents[2]
SQL=(ROOT/'supabase/preflight/meta-ads-atomic-window.sql').read_text()
assert hashlib.sha256(SQL.encode()).hexdigest()=='76a530de097e9b7cfea8099daa642e6bbadfbc257c46fc4867af219652779487'
CMD=['psql','-U','postgres','-XqAt','-v','ON_ERROR_STOP=1']
container=os.environ.get('NEWME_ADS_TEST_CONTAINER')
if container:
 assert re.fullmatch('newme-ads-atomic-[a-z0-9-]+',container)
 assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "newme.test"}}',container],text=True).strip()=='ads-atomic'
else:assert os.environ.get('PGHOST') in ('127.0.0.1','localhost')
def command(app):
 return ['docker','exec','-i','-e','PGAPPNAME='+app,'-e','PGDATABASE=newme_ads_atomic_test',container,*CMD] if container else CMD
def run(sql,app='ads-fixture'):
 return subprocess.run(command(app),input=sql,text=True,capture_output=True,env=dict(os.environ,PGAPPNAME=app),timeout=20)
def query(sql):
 p=run(sql);assert p.returncode==0,p.stderr;return p.stdout.strip()
def snapshot():
 return query("select md5(coalesce(string_agg(row_to_json(t)::text,'' order by id),'')) from public.ad_spend t")
def row(day='2026-01-01',amount=10,name='same'):
 return dict(campaign_name='fixture',adset_name='set',ad_name=name,spend_date=day,amount=amount,currency='AED',impressions=100,clicks=2,source='meta_api:123456789')
def statement(rows,role='service_role',since='2026-01-01',until='2026-01-02'):
 return f"set local role {role}; select public.replace_meta_ad_spend_window('123456789','{since}','{until}',$rows${json.dumps(rows)}$rows$::jsonb);"
def write(rows,role='service_role',app='ads-writer'):
 p=run('begin;'+statement(rows,role)+'commit;',app);assert p.returncode==0,p.stderr
 result=json.loads(p.stdout);assert result['ok'] and result['atomic'];return result
def fails(sql,code=None):
 before=snapshot();p=run(sql);assert p.returncode!=0
 if code:assert code in p.stderr,p.stderr
 assert snapshot()==before,'failed transaction changed committed rows'
def holder(sql):
 p=subprocess.Popen(command('ads-holder'),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=dict(os.environ,PGAPPNAME='ads-holder'))
 p.stdin.write('begin;'+sql+'\n');p.stdin.flush();p.stdout.readline();return p
def finish(p,commit=True):
 p.stdin.write(('commit;' if commit else 'rollback;')+'\n');p.stdin.close();assert p.wait(timeout=10)==0,p.stderr.read()
def blocked(app):
 for _ in range(70):
  if query("select exists(select 1 from pg_stat_activity where application_name='"+app+"' and wait_event='advisory')")=='t':return
  time.sleep(.04)
 raise AssertionError('independent writer never waited on the shared transaction lock')
groups=[]
query(SQL)
query('truncate public.ad_spend;')
query("insert into public.ad_spend(campaign_name,spend_date,amount,currency,source) values('protected','1990-01-01',7,'AED','meta')")
protected=query("select row_to_json(t)::text from public.ad_spend t where source='meta'")
for role in ['anon','authenticated']:
 fails('begin;'+statement([row()],role)+'commit;','permission denied')
groups.append('end-user RPC execution denied without data changes')
configuration="select p.proconfig @> ARRAY['search_path=\"\"','lock_timeout=5s','statement_timeout=20s']::text[] from pg_proc p where oid='public.replace_meta_ad_spend_window(text,date,date,jsonb)'::regprocedure"
assert query(configuration)=='t'
query('alter function public.replace_meta_ad_spend_window(text,date,date,jsonb) reset lock_timeout;')
assert query(configuration)=='f'
query("alter function public.replace_meta_ad_spend_window(text,date,date,jsonb) set lock_timeout='5s';")
assert query(configuration)=='t'
groups.append('catalog timeout drift is detected without changing function body')


# Identical display names may identify different upstream ads: preserve multiplicity.
result=write([row(),row()]);assert result['present']==2 and result['total_spend_aed']==20
result=write([row(),row()]);assert result['deleted']==2 and result['present']==2
groups.append('repeat replacement is idempotent and preserves same-name ad multiplicity')

for first_role,second_role in [('service_role','postgres'),('postgres','service_role')]:
 baseline=snapshot();first=holder(statement([row(amount=11),row('2026-01-02',12)],first_role))
 with concurrent.futures.ThreadPoolExecutor() as pool:
  pending=pool.submit(write,[row(amount=21),row('2026-01-02',22)],second_role,'ads-second')
  blocked('ads-second');assert snapshot()==baseline,'reader observed an uncommitted replacement'
  finish(first);receipt=pending.result(timeout=15)
 assert receipt['present']==2 and receipt['total_spend_aed']==43
groups.append('two independent writer roles serialize in both acquisition orders')

# Pause halfway through INSERT, while DELETE and the first INSERT are uncommitted.
query("create function public.ads_fixture_pause() returns trigger language plpgsql as $$begin if new.ad_name='paused' then perform pg_advisory_xact_lock(1313685843,2); end if; return new; end$$; create trigger ads_fixture_pause before insert on public.ad_spend for each row execute function public.ads_fixture_pause();")
baseline=snapshot();pause=holder('select pg_advisory_xact_lock(1313685843,2);')
with concurrent.futures.ThreadPoolExecutor() as pool:
 pending=pool.submit(write,[row(amount=31),row('2026-01-02',32,'paused')],'service_role','ads-partial')
 blocked('ads-partial');assert snapshot()==baseline,'reader saw a deleted or partial window'
 finish(pause);assert pending.result(timeout=15)['present']==2
query('drop trigger ads_fixture_pause on public.ad_spend;drop function public.ads_fixture_pause();')
groups.append('readers retain the old complete window during a mid-insert pause')

query("create function public.ads_fixture_fail() returns trigger language plpgsql as $$begin if new.ad_name='fail' then raise check_violation using message='injected fixture failure'; end if; return new; end$$; create trigger ads_fixture_fail before insert on public.ad_spend for each row execute function public.ads_fixture_fail();")
fails('begin;'+statement([row(amount=41),row('2026-01-02',42,'fail')])+'commit;','injected fixture failure')
query('drop trigger ads_fixture_fail on public.ad_spend;drop function public.ads_fixture_fail();')
assert write([row(),row('2026-01-02')])['present']==2
groups.append('mid-insert failure rolls back deletion and earlier inserts; retry succeeds')

query("create function public.ads_fixture_mutate() returns trigger language plpgsql as $$begin new.amount=new.amount+1; return new; end$$; create trigger ads_fixture_mutate before insert on public.ad_spend for each row execute function public.ads_fixture_mutate();")
fails('begin;'+statement([row()])+'commit;','window_row_readback_mismatch')
query('drop trigger ads_fixture_mutate on public.ad_spend;drop function public.ads_fixture_mutate();')
groups.append('same-count changed row content is rejected and rolled back')

for bad in [dict(row(),source='meta'),dict(row(),currency='USD'),dict(row(),amount=-1),dict(row(),amount=.001),dict(row(),spend_date='2026-02-01')]:
 fails('begin;'+statement([bad])+'commit;','invalid_ads_rows')
fails('begin;'+statement([])+'commit;','empty_window_requires_review')
query("delete from public.ad_spend where spend_date='2026-01-01'; insert into public.ad_spend(spend_date,amount,currency,source) values('2026-01-01',1,'AED',null)")
fails('begin;'+statement([row()])+'commit;','overlapping_spend_window')
query('delete from public.ad_spend where source is null;')
groups.append('foreign/null source, malformed rows and unexpected empty report fail closed')


# The mapper represents missing metrics as unknown, never as zero.
assert write([dict(row(),impressions=None,clicks=None)])['present']==1
assert query("select impressions is null and clicks is null from public.ad_spend where source='meta_api:123456789'")=='t'
groups.append('nullable mapper metrics remain unknown and round-trip')
# An import probe can be stale; the final database boundary still refuses it.
fails("begin;insert into public.ad_spend(spend_date,amount,currency,source) values('2026-01-01',9,'AED','legacy_excel');commit;",'overlapping_spend_window')
groups.append('stale import overlap probe cannot commit a second source')
# Maximum accepted same-day payload must use a statement-wide overlap check.
started=time.monotonic();assert write([row() for _ in range(20000)])['present']==20000
assert time.monotonic()-started<15,'maximum same-day window exceeded its bounded acceptance budget'
assert write([row(),row('2026-01-02')])['present']==2
groups.append('maximum 20000 same-day rows use bounded statement-level source checks')


baseline=snapshot();pause=holder('select pg_advisory_xact_lock(1313685843,1);')
fails('begin;'+statement([row()])+'commit;','lock timeout')
finish(pause,False);assert snapshot()==baseline
assert write([row(),row('2026-01-02')])['present']==2
assert query("select row_to_json(t)::text from public.ad_spend t where source='meta'")==protected
groups.append('lock timeout preserves data, releases safely and permits a later retry')
before=snapshot();query(SQL);assert snapshot()==before
groups.append('idempotent SQL reapply preserves all existing rows')
print(json.dumps({'ok':True,'isolated_database':True,'behavior_groups':len(groups),'groups':groups,'protected_rows_unchanged':True}))
