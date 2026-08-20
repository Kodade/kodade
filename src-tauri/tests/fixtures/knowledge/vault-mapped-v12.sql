/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
         );
INSERT INTO schema_migrations VALUES(1,1787198735700);
INSERT INTO schema_migrations VALUES(2,1787198735701);
INSERT INTO schema_migrations VALUES(3,1787198735702);
INSERT INTO schema_migrations VALUES(4,1787198735702);
INSERT INTO schema_migrations VALUES(5,1787198735703);
INSERT INTO schema_migrations VALUES(6,1787198735704);
INSERT INTO schema_migrations VALUES(7,1787198735704);
INSERT INTO schema_migrations VALUES(8,1787198735705);
INSERT INTO schema_migrations VALUES(9,1787198735706);
INSERT INTO schema_migrations VALUES(10,1787198735706);
INSERT INTO schema_migrations VALUES(11,1787198735708);
INSERT INTO schema_migrations VALUES(12,1787198735719);
CREATE TABLE workspaces (
            id TEXT PRIMARY KEY,
            canonical_root TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            color TEXT,
            capture_paused INTEGER NOT NULL DEFAULT 0 CHECK (capture_paused IN (0, 1)),
            activity_retention_days INTEGER NOT NULL DEFAULT 30,
            audit_retention_days INTEGER NOT NULL DEFAULT 30,
            tombstone_retention_days INTEGER NOT NULL DEFAULT 30,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
INSERT INTO workspaces VALUES('__WORKSPACE_ID__','__WORKSPACE_ROOT__','Fixture project',NULL,0,30,30,30,1787198735723,1787198735723);
CREATE TABLE memories (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('summary', 'decision', 'task', 'fact', 'preference')),
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('user', 'kodade', 'agent')),
            source_client TEXT NOT NULL,
            session_id TEXT,
            pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
            version INTEGER NOT NULL DEFAULT 1,
            idempotency_key TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER, canonical_project_id TEXT, canonical_record_id TEXT, canonical_relative_path TEXT, canonical_sha256 TEXT,
            UNIQUE(workspace_id, idempotency_key)
         );
PRAGMA writable_schema=ON;
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','memory_fts','memory_fts',0,'CREATE VIRTUAL TABLE memory_fts USING fts5(
            memory_id UNINDEXED,
            workspace_id UNINDEXED,
            title,
            body,
            tokenize = ''unicode61''
         )');
CREATE TABLE IF NOT EXISTS 'memory_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO memory_fts_data VALUES(1,X'');
INSERT INTO memory_fts_data VALUES(10,X'00000000000000');
CREATE TABLE IF NOT EXISTS 'memory_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'memory_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3);
CREATE TABLE IF NOT EXISTS 'memory_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'memory_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO memory_fts_config VALUES('version',4);
CREATE TABLE memory_links (
            source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            relation TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(source_id, target_id, relation),
            CHECK(source_id <> target_id)
         );
CREATE TABLE checkpoints (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            summary TEXT NOT NULL,
            decisions_json TEXT NOT NULL,
            next_actions_json TEXT NOT NULL,
            changed_paths_json TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('user', 'kodade', 'agent')),
            source_client TEXT NOT NULL,
            session_id TEXT,
            idempotency_key TEXT,
            created_at INTEGER NOT NULL, updates_state INTEGER NOT NULL DEFAULT 1
            CHECK (updates_state IN (0, 1)), canonical_project_id TEXT, canonical_checkpoint_id TEXT, canonical_relative_path TEXT,
            UNIQUE(workspace_id, idempotency_key)
         );
INSERT INTO checkpoints VALUES('cp_ef0cddf5b202bd18c9a879435e2c422a','__WORKSPACE_ID__','Recorded fixture checkpoint','["Recorded fixture decision"]','["Recorded fixture next action"]','["src/lib.rs"]','kodade','kodade-ui',NULL,NULL,1787198735810,0,'fixture-project','km_05270ffc3211380ff61b49a2d824e3e7','Worklog/2026/2026-08-20.md');
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','checkpoint_fts','checkpoint_fts',0,'CREATE VIRTUAL TABLE checkpoint_fts USING fts5(
            checkpoint_id UNINDEXED,
            workspace_id UNINDEXED,
            summary,
            tokenize = ''unicode61''
         )');
CREATE TABLE IF NOT EXISTS 'checkpoint_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO checkpoint_fts_data VALUES(1,X'01000003');
INSERT INTO checkpoint_fts_data VALUES(10,X'000000000101010001010101');
INSERT INTO checkpoint_fts_data VALUES(137438953473,X'000000320b30636865636b706f696e740106010204010766697874757265010601020301087265636f72646564010601020204110e');
CREATE TABLE IF NOT EXISTS 'checkpoint_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
INSERT INTO checkpoint_fts_idx VALUES(1,X'',2);
CREATE TABLE IF NOT EXISTS 'checkpoint_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2);
INSERT INTO checkpoint_fts_content VALUES(1,'cp_ef0cddf5b202bd18c9a879435e2c422a','__WORKSPACE_ID__','Recorded fixture checkpoint');
CREATE TABLE IF NOT EXISTS 'checkpoint_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
INSERT INTO checkpoint_fts_docsize VALUES(1,X'000003');
CREATE TABLE IF NOT EXISTS 'checkpoint_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO checkpoint_fts_config VALUES('version',4);
CREATE TABLE activity_events (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN (
                'project_opened', 'project_closed', 'session_started', 'session_exited',
                'active', 'idle', 'file_opened', 'file_saved', 'provider_launched'
            )),
            source TEXT NOT NULL,
            session_id TEXT,
            relative_path TEXT,
            provider TEXT,
            occurred_at INTEGER NOT NULL
         , sequence INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mcp_audit (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            client TEXT NOT NULL,
            capability TEXT NOT NULL,
            action TEXT NOT NULL,
            target_id TEXT,
            result TEXT NOT NULL,
            occurred_at INTEGER NOT NULL
         , session_id TEXT);
INSERT INTO mcp_audit VALUES('audit_960c00292d946ff71f1e6a01bc2441db','__WORKSPACE_ID__','kodade-ui','memory:write','map_workspace_project',NULL,'ok',1787198735728,NULL);
INSERT INTO mcp_audit VALUES('audit_ac672cc4e4a5730d88655c5d9c027686','__WORKSPACE_ID__','kodade-ui','memory:write','checkpoint','cp_ef0cddf5b202bd18c9a879435e2c422a','ok',1787198735852,NULL);
CREATE TABLE activity_workspace_sequences (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            next_sequence INTEGER NOT NULL
         );
CREATE TABLE working_memory_config (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            mode TEXT NOT NULL CHECK (mode IN ('commit', 'local')),
            activated_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_indexed_at INTEGER,
            last_commit TEXT
         );
CREATE TABLE working_memory_files (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('summary', 'decision')),
            updated_at INTEGER NOT NULL,
            UNIQUE(workspace_id, relative_path)
         );
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','working_memory_fts','working_memory_fts',0,'CREATE VIRTUAL TABLE working_memory_fts USING fts5(
            file_id UNINDEXED,
            workspace_id UNINDEXED,
            title,
            body,
            tokenize = ''unicode61''
         )');
CREATE TABLE IF NOT EXISTS 'working_memory_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO working_memory_fts_data VALUES(1,X'');
INSERT INTO working_memory_fts_data VALUES(10,X'00000000000000');
CREATE TABLE IF NOT EXISTS 'working_memory_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'working_memory_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3);
CREATE TABLE IF NOT EXISTS 'working_memory_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'working_memory_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO working_memory_fts_config VALUES('version',4);
CREATE TABLE projects_vault_config (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            canonical_root TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
INSERT INTO projects_vault_config VALUES(1,'__VAULT_ROOT__',1787198735721,1787198735721);
CREATE TABLE logical_projects (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
INSERT INTO logical_projects VALUES('fixture-project','Fixture project',1787198735728,1787198735728);
CREATE TABLE workspace_project_mappings (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES logical_projects(id) ON DELETE RESTRICT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
INSERT INTO workspace_project_mappings VALUES('__WORKSPACE_ID__','fixture-project',1787198735728,1787198735728);
CREATE TABLE project_documents (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES logical_projects(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('project', 'state', 'worklog', 'decision', 'knowledge')),
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            modified_at INTEGER NOT NULL,
            indexed_at INTEGER NOT NULL, memory_kind TEXT NOT NULL DEFAULT 'summary'
            CHECK (memory_kind IN ('summary', 'decision', 'task', 'fact', 'preference')), memory_source TEXT NOT NULL DEFAULT 'kodade'
            CHECK (memory_source IN ('user', 'kodade', 'agent')), memory_pinned INTEGER NOT NULL DEFAULT 0
            CHECK (memory_pinned IN (0, 1)), canonical_record_id TEXT, memory_version INTEGER NOT NULL DEFAULT 1, memory_updated_at INTEGER,
            UNIQUE(project_id, relative_path)
         );
INSERT INTO project_documents VALUES('project:fixture-project:546a71b18d202aaed00af1ea','fixture-project','Project.md','project','Fixture project',unistr('---\u000atitle: "Fixture project"\u000atype: project\u000aproject_id: fixture-project\u000astatus: active\u000arepositories: []\u000atags:\u000a  - project\u000a  - project/active\u000a---\u000a<!-- kodmem-project {"schema":1,"projectId":"fixture-project","authority":"projects-vault"} -->\u000a\u000a# Fixture project\u000a\u000a## Purpose\u000a\u000aDescribe the durable purpose and boundaries of this project.\u000a\u000a## Resume here\u000a\u000a- [[STATE|Current state]]\u000a- Latest daily note in `Worklog/`\u000a\u000a## Knowledge\u000a\u000a- [[Decisions/Decisions|Decisions]]\u000a- [[Plans/Plans|Plans]]\u000a- [[Research/Research|Research]]\u000a- [[References]]\u000a\u000a## Boundaries\u000a\u000a- The `kodmem-project` marker makes this project folder the portable KödMem authority.\u000a'),'344c9f64ceacefca28976cac53f9db18b5439b5f23f53aa50dbef6b6d4a4bbed',1787198735736,1787198735844,'summary','kodade',0,NULL,1,NULL);
INSERT INTO project_documents VALUES('project:fixture-project:d00043160708079311bcdb35','fixture-project','STATE.md','state','Fixture project State',unistr('---\u000atitle: "Fixture project State"\u000atype: state\u000aproject: "[[Project]]"\u000aproject_id: fixture-project\u000atags:\u000a  - project/state\u000a---\u000a\u000a# Fixture project state\u000a\u000a## Current state\u000a\u000a- Add the current verified project state.\u000a\u000a## Decisions\u000a\u000a- None recorded.\u000a\u000a## Risks\u000a\u000a- None recorded.\u000a\u000a## Next actions\u000a\u000a- Add the next concrete action.\u000a'),'e061d2f6042f38879e38c278c9b808e43880f457984916624eba8a8240cb0dfe',1787198735751,1787198735844,'summary','kodade',0,NULL,1,NULL);
INSERT INTO project_documents VALUES('project:fixture-project:00a2416659f5c6da951b386e','fixture-project','Worklog/2026/2026-08-20.md','worklog','Fixture project — 2026-08-20',unistr('---\u000atitle: "Fixture project — 2026-08-20"\u000atype: worklog\u000adate: 2026-08-20\u000a---\u000a\u000a# Fixture project — 2026-08-20\u000a\u000a<!-- kodmem-checkpoint {"schema":1,"checkpointId":"km_05270ffc3211380ff61b49a2d824e3e7","projectId":"fixture-project","source":"kodade","sourceClient":"kodade-ui","sessionId":null,"idempotencyKeyHash":null,"payloadHash":"18ccd3ae13e1d44a1a31162fc27bd5bf47da52e13fa4b548e5bac905e0b2338a","createdAt":1787198735810,"updatesState":false,"summary":"Recorded fixture checkpoint","decisions":["Recorded fixture decision"],"nextActions":["Recorded fixture next action"],"changedPaths":["src/lib.rs"]} -->\u000a## 2026-08-20T04-05-35-810Z\u000a\u000aRecorded fixture checkpoint\u000a\u000a### Decisions\u000a\u000a- Recorded fixture decision\u000a\u000a### Next actions\u000a\u000a- Recorded fixture next action\u000a\u000a### Changed paths\u000a\u000a- src/lib.rs\u000a<!-- /kodmem-checkpoint km_05270ffc3211380ff61b49a2d824e3e7 -->\u000a'),'c3080d0f926a05cda1da4fb3c68cef5c3ff5f28bf71d1b65db47a74d8770fbef',1787198735825,1787198735844,'summary','kodade',0,NULL,1,NULL);
INSERT INTO project_documents VALUES('project:fixture-project:c88c4948f8e309f1dc26abbd','fixture-project','Decisions/checkpoint-km_05270ffc3211380ff61b49a2d824e3e7-01.md','decision','Recorded fixture decision',unistr('---\u000atitle: "Recorded fixture decision"\u000atype: decision\u000astatus: accepted\u000aagent_context: true\u000aproject_id: fixture-project\u000a---\u000a<!-- kodmem-checkpoint-decision {"schema":1,"checkpointId":"km_05270ffc3211380ff61b49a2d824e3e7","index":0} -->\u000a\u000a# Recorded fixture decision\u000a\u000aRecorded fixture decision\u000a'),'9c43618eb17c82b752cbf8729605055c4b77644b6b864018b170fdeed79612c9',1787198735835,1787198735844,'decision','kodade',0,NULL,1,NULL);
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','project_document_fts','project_document_fts',0,'CREATE VIRTUAL TABLE project_document_fts USING fts5(
            document_id UNINDEXED,
            project_id UNINDEXED,
            title,
            body,
            tokenize = ''unicode61''
         )');
CREATE TABLE IF NOT EXISTS 'project_document_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO project_document_fts_data VALUES(1,X'0400000d8165');
INSERT INTO project_document_fts_data VALUES(10,X'000000000104040004010101020101030101040101');
INSERT INTO project_document_fts_data VALUES(137438953473,X'0000021e02303101060103150106616374697665010801030c0702026e64010601032302087574686f72697479010801031932010a626f756e64617269657301080103241b010763757272656e74010601032b01056461696c79010601032e020865636973696f6e73010a01033303030306736372696265010601031f0206757261626c650106010321010766697874757265011201020201030308100702056f6c6465720106010345010468657265010601032901026964010601030802016e010601033001096b6e6f776c65646765010601033202056f646d656d010a0103122f0b01066c6174657374010601032d01056d616b657301060103420304726b6572010601034101046e6f7465010601032f01026f6601060103250105706c616e73010a010336030302076f727461626c6501060103470206726f6a656374012201020301030404030507030507070c1b06080269640106010316080173010601031a02067572706f7365010801031e06010a7265666572656e636573010601033c030a706f7369746f72696573010601030d0306736561726368010a01033903030403756d6501060103280106736368656d610106010314020474617465010801032a0405027573010601030b010474616773010601030e02026865010a010320200a0302697301080103261f020469746c6501060103020203797065010601030501057661756c74010601031b0107776f726b6c6f67010601033104080e0910120e0c110d0d140c0b0908100e0d0c0b0b090e0e1b09080e11110f0a0d0c090b0b0a0b0a0c');
INSERT INTO project_document_fts_data VALUES(274877906945,X'000001030730616374696f6e02060103280701730206010323020264640208010316100108636f6e637265746502060103270206757272656e7402080103140601096465636973696f6e73020601031c01076669787475726502100102020103030b0701026964020601030b01046e65787402080103220602036f6e65020801031d05010770726f6a656374021a0102030103040603030504050a01087265636f72646564020801031e05020469736b73020601031f010573746174650216010204010305040b050408010474616773020601030e02026865020801031710020469746c65020601030202037970650206010306010876657269666965640206010319040d080a0f0e1013090c0b18100b140b0a0b0a');
INSERT INTO project_document_fts_data VALUES(412316860417,X'000002c9033030350306010340031e323730666663333231313338306666363162343961326438323465336537030801031941020138031201020501030608072f0101310306010316020c3738373139383733353831300306010329023f3863636433616531336531643434613161333131363266633237626435626634376461353265313366613462353438653562616339303565306232333338610306010327010232300310010206010307080703023236031201020401030508072f0303743034030601033f01023335030601034101043831307a03060103420106616374696f6e030801033819070173030601034b01076368616e6765640306010350080570617468730306010339030865636b706f696e74030c0103141d18130b0269640306010317020872656174656461740306010328010464617465030601030a020765636973696f6e030801033318090173030801033018010566616c7365030601032b0206697874757265031c0102020103030d0f15060610060701126964656d706f74656e63796b657968617368030601032401026b6d03080103184102056f64616465030801031e0404036d656d03080103134401036c6962030801033b1a01046e657874030a01033715060507616374696f6e7303060103340203756c6c0308010323040105706174687303060103510309796c6f61646861736803060103260206726f6a65637403100102030103040d0f08026964030601031a01087265636f72646564031001032d0606100607020173030801033c1a0106736368656d6103060103150208657373696f6e6964030601032202056f75726365030601031d0706636c69656e74030601031f02027263030801033a1a0206756d6d617279030601032c01057469746c65030601030202037970650306010308010275690306010321020b7064617465737374617465030601032a0107776f726b6c6f6703060103090409260e0813460e0f0a090b0e080e0c12090f0b0f090c18190a0d0b0b0d0e0b0c10120914090d0f0c0d0a0d0c0a0912');
INSERT INTO project_document_fts_data VALUES(549755813889,X'0000012a023030040601031a021f3532373066666333323131333830666636316234396132643832346533653704060103180101310406010315010861636365707465640406010309020467656e74040601030a010a636865636b706f696e7404060103120b026964040601031602066f6e74657874040601030b01086465636973696f6e0414010204010305040e0c0501076669787475726504120102030103040d0f0501026964040601030e02046e646578040601031901026b6d040601031702056f646d656d0406010311010770726f6a656374040801030d0501087265636f7264656404100102020103031a050106736368656d61040601031402057461747573040601030801057469746c6504060103020203727565040601030c02037970650406010306040826080f0b11090d1614090b090c0f140d0c0c0a');
CREATE TABLE IF NOT EXISTS 'project_document_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
INSERT INTO project_document_fts_idx VALUES(1,X'',2);
INSERT INTO project_document_fts_idx VALUES(2,X'',2);
INSERT INTO project_document_fts_idx VALUES(3,X'',2);
INSERT INTO project_document_fts_idx VALUES(4,X'',2);
CREATE TABLE IF NOT EXISTS 'project_document_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3);
INSERT INTO project_document_fts_content VALUES(1,'project:fixture-project:546a71b18d202aaed00af1ea','fixture-project','Fixture project',unistr('---\u000atitle: "Fixture project"\u000atype: project\u000aproject_id: fixture-project\u000astatus: active\u000arepositories: []\u000atags:\u000a  - project\u000a  - project/active\u000a---\u000a<!-- kodmem-project {"schema":1,"projectId":"fixture-project","authority":"projects-vault"} -->\u000a\u000a# Fixture project\u000a\u000a## Purpose\u000a\u000aDescribe the durable purpose and boundaries of this project.\u000a\u000a## Resume here\u000a\u000a- [[STATE|Current state]]\u000a- Latest daily note in `Worklog/`\u000a\u000a## Knowledge\u000a\u000a- [[Decisions/Decisions|Decisions]]\u000a- [[Plans/Plans|Plans]]\u000a- [[Research/Research|Research]]\u000a- [[References]]\u000a\u000a## Boundaries\u000a\u000a- The `kodmem-project` marker makes this project folder the portable KödMem authority.\u000a'));
INSERT INTO project_document_fts_content VALUES(2,'project:fixture-project:d00043160708079311bcdb35','fixture-project','Fixture project State',unistr('---\u000atitle: "Fixture project State"\u000atype: state\u000aproject: "[[Project]]"\u000aproject_id: fixture-project\u000atags:\u000a  - project/state\u000a---\u000a\u000a# Fixture project state\u000a\u000a## Current state\u000a\u000a- Add the current verified project state.\u000a\u000a## Decisions\u000a\u000a- None recorded.\u000a\u000a## Risks\u000a\u000a- None recorded.\u000a\u000a## Next actions\u000a\u000a- Add the next concrete action.\u000a'));
INSERT INTO project_document_fts_content VALUES(3,'project:fixture-project:00a2416659f5c6da951b386e','fixture-project','Fixture project — 2026-08-20',unistr('---\u000atitle: "Fixture project — 2026-08-20"\u000atype: worklog\u000adate: 2026-08-20\u000a---\u000a\u000a# Fixture project — 2026-08-20\u000a\u000a<!-- kodmem-checkpoint {"schema":1,"checkpointId":"km_05270ffc3211380ff61b49a2d824e3e7","projectId":"fixture-project","source":"kodade","sourceClient":"kodade-ui","sessionId":null,"idempotencyKeyHash":null,"payloadHash":"18ccd3ae13e1d44a1a31162fc27bd5bf47da52e13fa4b548e5bac905e0b2338a","createdAt":1787198735810,"updatesState":false,"summary":"Recorded fixture checkpoint","decisions":["Recorded fixture decision"],"nextActions":["Recorded fixture next action"],"changedPaths":["src/lib.rs"]} -->\u000a## 2026-08-20T04-05-35-810Z\u000a\u000aRecorded fixture checkpoint\u000a\u000a### Decisions\u000a\u000a- Recorded fixture decision\u000a\u000a### Next actions\u000a\u000a- Recorded fixture next action\u000a\u000a### Changed paths\u000a\u000a- src/lib.rs\u000a<!-- /kodmem-checkpoint km_05270ffc3211380ff61b49a2d824e3e7 -->\u000a'));
INSERT INTO project_document_fts_content VALUES(4,'project:fixture-project:c88c4948f8e309f1dc26abbd','fixture-project','Recorded fixture decision',unistr('---\u000atitle: "Recorded fixture decision"\u000atype: decision\u000astatus: accepted\u000aagent_context: true\u000aproject_id: fixture-project\u000a---\u000a<!-- kodmem-checkpoint-decision {"schema":1,"checkpointId":"km_05270ffc3211380ff61b49a2d824e3e7","index":0} -->\u000a\u000a# Recorded fixture decision\u000a\u000aRecorded fixture decision\u000a'));
CREATE TABLE IF NOT EXISTS 'project_document_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
INSERT INTO project_document_fts_docsize VALUES(1,X'00000248');
INSERT INTO project_document_fts_docsize VALUES(2,X'00000327');
INSERT INTO project_document_fts_docsize VALUES(3,X'00000557');
INSERT INTO project_document_fts_docsize VALUES(4,X'0000031f');
CREATE TABLE IF NOT EXISTS 'project_document_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO project_document_fts_config VALUES('version',4);
CREATE TABLE portable_observation (
            workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
            last_commit TEXT,
            updated_at INTEGER NOT NULL
         );
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories
         WHEN new.deleted_at IS NULL BEGIN
            INSERT INTO memory_fts(memory_id, workspace_id, title, body)
            VALUES (new.id, new.workspace_id, new.title, new.body);
         END;
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
            DELETE FROM memory_fts WHERE memory_id = old.id;
            INSERT INTO memory_fts(memory_id, workspace_id, title, body)
            SELECT new.id, new.workspace_id, new.title, new.body
            WHERE new.deleted_at IS NULL;
         END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
            DELETE FROM memory_fts WHERE memory_id = old.id;
         END;
CREATE TRIGGER checkpoints_fts_insert AFTER INSERT ON checkpoints BEGIN
            INSERT INTO checkpoint_fts(checkpoint_id, workspace_id, summary)
            VALUES (new.id, new.workspace_id, new.summary);
         END;
CREATE TRIGGER checkpoints_fts_delete AFTER DELETE ON checkpoints BEGIN
            DELETE FROM checkpoint_fts WHERE checkpoint_id = old.id;
         END;
CREATE TRIGGER working_memory_fts_insert AFTER INSERT ON working_memory_files BEGIN
            INSERT INTO working_memory_fts(file_id, workspace_id, title, body)
            VALUES (new.id, new.workspace_id, new.title, new.body);
         END;
CREATE TRIGGER working_memory_fts_update AFTER UPDATE ON working_memory_files BEGIN
            DELETE FROM working_memory_fts WHERE file_id = old.id;
            INSERT INTO working_memory_fts(file_id, workspace_id, title, body)
            VALUES (new.id, new.workspace_id, new.title, new.body);
         END;
CREATE TRIGGER working_memory_fts_delete AFTER DELETE ON working_memory_files BEGIN
            DELETE FROM working_memory_fts WHERE file_id = old.id;
         END;
CREATE TRIGGER project_documents_fts_insert AFTER INSERT ON project_documents BEGIN
            INSERT INTO project_document_fts(document_id, project_id, title, body)
            VALUES (new.id, new.project_id, new.title, new.body);
         END;
CREATE TRIGGER project_documents_fts_update AFTER UPDATE ON project_documents BEGIN
            DELETE FROM project_document_fts WHERE document_id = old.id;
            INSERT INTO project_document_fts(document_id, project_id, title, body)
            VALUES (new.id, new.project_id, new.title, new.body);
         END;
CREATE TRIGGER project_documents_fts_delete AFTER DELETE ON project_documents BEGIN
            DELETE FROM project_document_fts WHERE document_id = old.id;
         END;
CREATE INDEX memory_links_target_idx ON memory_links(target_id);
CREATE INDEX checkpoints_workspace_created_idx
            ON checkpoints(workspace_id, created_at DESC);
CREATE INDEX activity_workspace_time_idx
            ON activity_events(workspace_id, occurred_at DESC);
CREATE INDEX audit_workspace_time_idx
            ON mcp_audit(workspace_id, occurred_at DESC);
CREATE UNIQUE INDEX activity_workspace_sequence_idx
            ON activity_events(workspace_id, sequence);
CREATE INDEX activity_workspace_time_sequence_idx
            ON activity_events(workspace_id, occurred_at DESC, sequence DESC);
CREATE INDEX working_memory_files_workspace_idx
            ON working_memory_files(workspace_id, updated_at DESC);
CREATE INDEX workspace_project_mappings_project_idx
            ON workspace_project_mappings(project_id, workspace_id);
CREATE INDEX project_documents_project_modified_idx
            ON project_documents(project_id, modified_at DESC, relative_path);
CREATE INDEX memories_canonical_project_idx
            ON memories(workspace_id, canonical_project_id, canonical_record_id);
CREATE INDEX checkpoints_canonical_project_idx
            ON checkpoints(workspace_id, canonical_project_id, canonical_checkpoint_id);
PRAGMA writable_schema=OFF;
COMMIT;
