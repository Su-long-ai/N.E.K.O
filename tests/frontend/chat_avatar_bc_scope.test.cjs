const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const portraitA = 'data:image/png;base64,b3duZXI=';
const injectedA = 'data:image/png;base64,cHJpb3I=';
const wrong = 'data:image/png;base64,d3Jvbmc=';
const queue = [];
const windows = [];
function fixture(route, type, options = {}) {
    const defaultModelPath = type === 'vrm' ? '/Shared.vrm' : '/Shared.model3.json';
    const modelKey = type + ':' + defaultModelPath;
    const cards = options.cards || Object.fromEntries(['A', 'B', 'C'].map(name => [name,
        type === 'vrm' ? {model_type: type, vrm: defaultModelPath} : {model_type: type, live2d: defaultModelPath}
    ]));
    const pageConfigReads = [];
    const listeners = new Map();
    const store = new Map();
    const writes = [];
    const requests = [];
    const commits = [];
    const received = [];
    const timers = new Map();
    let characterReads = 0;
    const window = {
        location: { pathname: route },
        lanlan_config: { lanlan_name: 'A', switch_revision: 10, model_type: type },
        vrmModel: '/Shared.vrm',
        vrmManager: route === '/' && type === 'vrm' ? { currentModel: { vrm: {} } } : undefined,
        cubism4Model: '/Shared.model3.json',
        live2dManager: route === '/' && type === 'live2d' ? {_lastLoadedModelPath: '/Shared.model3.json'} : undefined,
        appState: { incomingAudioEpoch: 0, dom: {} },
        document: {},
        invalidatePendingMusicSearch() {},
        connectWebSocket() {},
        unlockAchievement: options.unlockAchievement,
        requestAnimationFrame(fn) { fn(); },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn));
        },
        dispatchEvent(event) {
            received.push(event);
            for (const fn of listeners.get(event.type) || []) fn(event);
        },
        appChatAvatarState: {
            beginCharacterSwitch() {},
            commitCharacterSwitch(_id, info) { commits.push(info.name); },
            rollbackCharacterSwitch() {},
            initialize() {},
            getDataUrl() { return ''; }
        }
    };
    const firstCharacterRead = options.beforeFirstCharacterRead;
    const ctx = vm.createContext({
        window,
        document: { readyState: 'loading', body: { classList: { add() {} } }, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
        console: { log() {}, info() {}, warn() {}, error() {} },
        Event: class { constructor(type) { this.type = type; } },
        CustomEvent: class { constructor(type, {detail} = {}) { Object.assign(this, {type, detail}); } },
        WebSocket: { OPEN: 1, CLOSED: 3, CLOSING: 2 },
        setTimeout(fn, delay) { if (delay === 100) queueMicrotask(fn); timers.set(fn, delay); return fn; },
        clearTimeout(fn) { timers.delete(fn); },
        clearInterval() {},
        cancelAnimationFrame() {},
        BroadcastChannel: class { close() {} },
        localStorage: {
            getItem: key => store.get(key) ?? null,
            removeItem: key => store.delete(key),
            setItem(key, value) { writes.push(key); store.set(key, value); }
        },
        fetch: async (url, init) => {
            if (init?.method === 'POST') requests.push(url);
            if (url === '/api/characters' && window.appState.isSwitchingCatgirl && ++characterReads === 1) await firstCharacterRead?.();
            const match = url.match(/^\/api\/config\/page_config\?lanlan_name=(.+)$/);
            if (match) {
                const name = decodeURIComponent(match[1]);
                pageConfigReads.push(name);
                if (options.readPageConfig) await options.readPageConfig(name);
                const card = cards[name];
                const data = options.pageConfigs?.[name] || {
                    success: true, lanlan_name: name, model_type: card.model_type,
                    live3d_sub_type: card.live3d_sub_type,
                    model_path: card.vrm || card.mmd || card.live2d || '',
                    pngtuber: card.pngtuber,
                };
                return {ok: true, json: async () => data};
            }
            return {ok: true, json: async () => ({'猫娘': cards})};
        },
    });
    const load = name => vm.runInContext(readFileSync(path.join(root, name), 'utf8'), ctx, {filename: name});
    load('static/app/app-interpage/bootstrap-resources-and-model-reload.js');
    const i = window.__appInterpageParts;
    Object.assign(i, {
        isIcebreakerBridgeAction: () => false,
        isYuiGuideLifecycleStartAction: () => false,
        isYuiGuideLifecycleScopedAction: () => false,
        isYuiGuideMessageForCurrentLifecycle: () => true,
        drainPendingYuiGuideChatBridgeQueue() {},
        postYuiGuideMessageToPet(action, detail) { queue.push({from: route, to: '/', action, ...detail}); },
        postYuiGuideMessageToChat(action, detail) { queue.push({from: route, to: '/chat', action, ...detail}); },
    });
    if (route === '/' || options.fromStorage) store.set('neko_avatar:A', JSON.stringify({dataUrl: portraitA, modelType: type, cacheKey: modelKey}));
    load('static/app/app-chat-avatar.js');
    load('static/app/app-interpage/guide-message-relay.js');
    load('static/app/app-character.js');
    window.appChatAvatar.init();
    const dataUrl = () => window.appChatAvatar.getModelAvatarDataUrl();
    const event = (data) => i.handleNekoBroadcastMessage({data});
    const runWatchdog = () => {
        const callbacks = [...timers].filter(([, delay]) => delay === 45000);
        assert.equal(callbacks.length, 1);
        callbacks[0][0]();
    };
    const result = {window, dataUrl, event, store, writes, commits, modelKey, requests, received, runWatchdog, pageConfigReads};
    windows.push(result);
    return result;
}
async function flush() {
    for (let counter = 0; counter < 15; counter++) {
        const m = queue.shift();
        if (!m) return;
        for (const w of windows.filter(w => w.window.location.pathname !== m.from &&
                (m.to === '/' ? w.window.location.pathname === '/' : w.window.location.pathname !== '/'))) {
            await w.event(m);
        }
    }
    assert.fail('preview handshake must not loop');
}
async function switchFollower(follower, next, previous, revision) {
    await follower.event({action: 'catgirl_switched', new_catgirl: next, old_catgirl: previous, switch_revision: revision});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(follower.window.lanlan_config.lanlan_name, next);
    assert.equal(follower.commits.at(-1), next);
}
function ownerCompletes(owner, name, revision, type) {
    Object.assign(owner.window.lanlan_config, {lanlan_name: name, switch_revision: revision});
    // Call production same-key loaded handler. Fixture is deliberately not
    // capable of producing any new portrait after this old-model reuse.
    if (type === 'vrm') owner.window.dispatchEvent({type: 'vrm-model-loaded'});
    else owner.window.live2dManager.onModelLoaded();
    // The real app-character final commit hook is exercised on the chat side;
    // here the focused owner fixture models its actual successful commit point.
    owner.window.appChatAvatar.onCharacterScopeCommitted?.(name, revision);
    assert.equal(owner.dataUrl(), portraitA);
}
for (const route of ['/chat', '/chat_full']) for (const type of ['vrm', 'live2d']) {
    for (const early of ['owner-first', 'follower-first']) {
        test(route+' '+type+' '+early+' gets a current owner portrait for uncached B after actual BC role switch', async () => {
            windows.length = 0; queue.length = 0;
            const owner = fixture('/', type), follower = fixture(route, type);
            await follower.event({action:'avatar_updated',lanlan_name:'A',dataUrl:injectedA,modelType:type});
            assert.equal(follower.dataUrl(), injectedA);
            assert.equal(owner.store.has('neko_avatar:B'), false);
            if (early === 'owner-first') { ownerCompletes(owner, 'B', 11, type); await flush(); }
            await switchFollower(follower, 'B', 'A', 11);
            await flush();
            if (early === 'follower-first') {
                assert.equal(follower.dataUrl(), '', 'B must not retain A while owner still A');
                ownerCompletes(owner, 'B', 11, type); await flush();
            }
            assert.equal(follower.dataUrl(), portraitA, 'uncached B must use actual shared-model portrait from Pet');
            assert.equal(owner.store.has('neko_avatar:B'), false);
            assert.deepEqual(follower.writes, []);
            assert.deepEqual(follower.requests, []);
        });
    }
}

test('recovery refuses wrong source / name / revision / full key / model type / sender window and is idempotent', async () => {
    windows.length = 0; queue.length = 0;
    const owner = fixture('/', 'vrm'), follower = fixture('/chat', 'vrm');
    await follower.event({action:'avatar_updated',lanlan_name:'A',dataUrl:injectedA,modelType:'vrm'});
    await switchFollower(follower, 'B', 'A', 11);
    // The Pet config can show B during async rendering, but must not yet
    // answer current scope B with old caches.
    Object.assign(owner.window.lanlan_config, {lanlan_name:'B',switch_revision:11});
    assert.equal(owner.dataUrl(), portraitA);
    await flush();
    assert.equal(follower.dataUrl(), '');
    const scope = {name:'B', revision:11, modelKey:follower.modelKey};
    const scopedPacket = {action:'avatar_updated', lanlan_name:'B',dataUrl:wrong,modelType:'vrm',avatar_source:'pet',avatar_scope:scope};
    for (const patch of [
        {avatar_source:'chat'},
        {lanlan_name:'A'},
        {avatar_scope:{...scope,revision:10}},
        {avatar_scope:{...scope,revision:12}},
        {avatar_scope:{...scope,name:'A'}},
        {avatar_scope:{...scope,modelKey:'vrm:/Different.vrm'}},
        {avatar_scope:{}},
        {modelType:'live2d'},
        {dataUrl:'not-a-raster'}
    ]) await follower.event({...scopedPacket,...patch});
    assert.equal(follower.dataUrl(), '');
    await owner.event({...scopedPacket});
    assert.equal(owner.dataUrl(), portraitA, 'Pet cannot consume a scoped follower response');
    ownerCompletes(owner,'B',11,'vrm');
    assert.equal(queue.length, 1);
    const packet = {...queue[0]};
    await flush();
    assert.equal(follower.dataUrl(), portraitA);
    const updates = follower.received.filter(event => event.type === 'chat-avatar-preview-updated').length;
    await follower.event(packet);
    assert.equal(follower.received.filter(event => event.type === 'chat-avatar-preview-updated').length, updates);
    await switchFollower(follower,'C','B',12);
    await follower.event(packet);
    assert.equal(follower.dataUrl(),'','late B must not restore its image after committed C');
    assert.deepEqual(follower.writes, []);
});

test('a different owner model key cannot satisfy same-model recovery using the follower’s previous key', async () => {
    windows.length = 0; queue.length = 0;
    const owner=fixture('/','vrm'), follower=fixture('/chat_full','vrm');
    await follower.event({action:'avatar_updated',lanlan_name:'A',dataUrl:injectedA,modelType:'vrm'});
    await switchFollower(follower,'B','A',11);
    Object.assign(owner.window.lanlan_config,{lanlan_name:'B',switch_revision:11});
    owner.window.vrmModel='/Different.vrm';
    owner.window.appChatAvatar.onCharacterScopeCommitted('B',11);
    await flush();
    assert.equal(follower.dataUrl(),'');
    // Existing capture publication, not the new same-key recovery, still
    // displays a fresh different-model portrait received from the owner.
    await follower.event({action:'avatar_updated',lanlan_name:'B',dataUrl:portraitA,modelType:'vrm'});
    assert.equal(follower.dataUrl(),portraitA);
});

function hold() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return {promise, release};
}
const settleSwitch = () => new Promise(resolve => setImmediate(resolve));
const queueSwitch = (w, name, prior, revision) => w.event({
    action: 'catgirl_switched', new_catgirl: name, old_catgirl: prior, switch_revision: revision,
});
const committedRevisions = w => w.received.filter(e => e.type === 'neko:avatar-scope-committed')
    .map(e => e.detail.revision);

for (const [route, type] of [['/chat', 'vrm'], ['/chat_full', 'live2d']]) {
    for (const watchdog of [false, true]) {
        test(route+' replays a newer same-name pending avatar scope on '+(watchdog ? 'watchdog' : 'finally'), async () => {
            windows.length = 0; queue.length = 0;
            const firstConfig = hold(), firstAchievement = hold();
            let achievements = 0;
            const owner = fixture('/', type);
            const follower = fixture(route, type, {
                beforeFirstCharacterRead: () => firstConfig.promise,
                unlockAchievement: watchdog ? () => ++achievements === 1 ? firstAchievement.promise : undefined : undefined,
            });
            await follower.event({action:'avatar_updated',lanlan_name:'A',dataUrl:injectedA,modelType:type});
            assert.equal(follower.dataUrl(), injectedA);
            await queueSwitch(follower, 'B', 'A', 11);
            assert.equal(follower.window.appState.isSwitchingCatgirl, true);
            await queueSwitch(follower, 'C', 'B', 12);
            await queueSwitch(follower, 'B', 'C', 13);
            assert.equal(follower.window.appState._pendingCatgirlSwitch.switchRevision, 13);
            assert.equal(follower.window.lanlan_config.switch_revision, 13);
            firstConfig.release();
            await settleSwitch();
            if (watchdog) {
                assert.deepEqual(follower.commits, ['B'], 'B/11 started, reached its commit, and is still in the tail');
                assert.deepEqual(committedRevisions(follower), [], 'B/11 cannot authorize the current B/13 scope');
                follower.runWatchdog();
                await settleSwitch();
                firstAchievement.release();
                await settleSwitch();
            }
            ownerCompletes(owner, 'B', 13, type);
            await flush();
            assert.equal(follower.dataUrl(), portraitA, 'the first usable portrait must belong to latest B/13');
            assert.deepEqual(committedRevisions(follower), [13]);
            assert.deepEqual(follower.commits, ['B', 'B'], 'play only current B/11 then latest B/13, never superseded C/12');
            assert.deepEqual(follower.writes, []);
            assert.equal(owner.store.has('neko_avatar:B'), false);
        });
    }
}

for (const repeat of [0, 11]) {
    test('an in-flight same-name duplicate with revision '+repeat+' does not replay', async () => {
        windows.length = 0; queue.length = 0;
        const firstConfig = hold(), type = 'vrm';
        const owner = fixture('/', type);
        const follower = fixture('/chat', type, {beforeFirstCharacterRead: () => firstConfig.promise});
        await follower.event({action:'avatar_updated',lanlan_name:'A',dataUrl:injectedA,modelType:type});
        await queueSwitch(follower, 'B', 'A', 11);
        await queueSwitch(follower, 'B', 'A', repeat);
        firstConfig.release();
        await settleSwitch();
        ownerCompletes(owner, 'B', 11, type);
        await flush();
        assert.equal(follower.dataUrl(), portraitA);
        assert.deepEqual(committedRevisions(follower), [11]);
        assert.deepEqual(follower.commits, ['B']);
    });
}

for (const [route, type] of [['/chat', 'vrm'], ['/chat_full', 'live2d']]) {
    for (const ownerFirst of [false, true]) {
        test(route+' preserves an uncached current portrait on a newer same-name receipt ('+(ownerFirst ? 'owner first' : 'follower first')+')', async () => {
            windows.length = 0; queue.length = 0;
            const owner = fixture('/', type);
            const follower = fixture(route, type);
            await follower.event({action:'avatar_updated',lanlan_name:'A',dataUrl:injectedA,modelType:type});
            await switchFollower(follower, 'B', 'A', 11);
            ownerCompletes(owner, 'B', 11, type);
            await flush();
            assert.equal(follower.dataUrl(), portraitA);
            assert.equal(owner.store.has('neko_avatar:B'), false);
            const late = {action:'avatar_updated',lanlan_name:'B',dataUrl:wrong,modelType:type,
                avatar_source:'pet',avatar_scope:{name:'B',revision:11,modelKey:follower.modelKey}};
            if (ownerFirst) {
                await queueSwitch(owner, 'B', 'B', 12);
                await flush(); // early owner publication must wait for follower acceptance
            }
            await queueSwitch(follower, 'B', 'B', 12);
            await follower.event(late);
            await flush();
            if (!ownerFirst) {
                assert.equal(follower.dataUrl(), '', 'do not relabel the rev11 image while owner still rev11');
                await queueSwitch(owner, 'B', 'B', 12);
                await flush();
            }
            assert.equal(follower.dataUrl(), portraitA, 'first usable model portrait after the same-name receipt');
            assert.deepEqual(committedRevisions(follower), [11, 12]);
            assert.deepEqual(follower.commits, ['B'], 'the same-name receipt must not reload the model');
            assert.deepEqual(owner.commits, [], 'the healthy Pet must not reload');
            await queueSwitch(follower, 'B', 'B', 12);
            await queueSwitch(follower, 'B', 'B', 0);
            await queueSwitch(follower, 'B', 'B', 11);
            await follower.event(late);
            await flush();
            assert.deepEqual(committedRevisions(follower), [11, 12], 'duplicates/stale/unstamped receipts publish nothing');
            assert.equal(follower.dataUrl(), portraitA);
            assert.deepEqual(follower.writes, []);
            assert.equal(owner.store.has('neko_avatar:B'), false);
        });
    }
}

function scopedRequests(route, name) {
    return queue.filter(item => item.from === route && item.action === 'request_avatar' && item.avatar_scope?.name === name);
}

for (const route of ['/chat', '/chat_full']) {
    test(route + ' retires a cold-start portrait from A storage and requests the exact uncached B scope', async () => {
        windows.length = 0; queue.length = 0;
        const owner = fixture('/', 'vrm');
        const follower = fixture(route, 'vrm', {fromStorage: true});
        // A starts with durable owner-written bytes. No avatar_updated or local capture after startup.
        assert.equal(follower.dataUrl(), portraitA);
        assert.equal(follower.store.has('neko_avatar:B'), false);
        await switchFollower(follower, 'B', 'A', 11);
        assert.equal(follower.dataUrl(), '', 'uncached B must never display the A storage portrait');
        assert.deepEqual(scopedRequests(route, 'B').map(packet => packet.avatar_scope.modelKey), ['vrm:/Shared.vrm']);
        await flush(); // Owner intentionally still A when the first B request is processed.
        ownerCompletes(owner, 'B', 11, 'vrm');
        await flush();
        assert.equal(follower.dataUrl(), portraitA, 'B can display the same model only after exact fresh owner proof');
        assert.equal(follower.store.has('neko_avatar:B'), false, 'followers must not persist owner replies');
        assert.deepEqual(follower.writes, []);
    });

    for (const [modelType, modelPath, card, pageConfig] of [
        ['vrm', '/user_vrm/N%20Alt.vrm', {model_type: 'vrm', vrm: 'N Alt.vrm'},
            {model_type: 'live3d', live3d_sub_type: 'vrm', model_path: '/user_vrm/N%20Alt.vrm'}],
        ['mmd', '/user_mmd/N.pmx', {model_type: 'live3d', live3d_sub_type: 'mmd', mmd: 'N.pmx'},
            {model_type: 'live3d', live3d_sub_type: 'mmd', model_path: '/user_mmd/N.pmx'}],
        ['live2d', '/workshop/42/N.model3.json', {model_type: 'live2d', live2d: 'N.model3.json'},
            {model_type: 'live2d', model_path: '/workshop/42/N.model3.json'}],
        ['pngtuber', '{"layeredMetadata":"","idleImage":"/static/N.png","talkingImage":"/static/N-talk.png"}',
            {model_type: 'pngtuber', pngtuber: {idle_image: 'N.png', talking_image: 'N-talk.png'}},
            {model_type: 'pngtuber', model_path: '/static/N.png', pngtuber: {idle_image: '/static/N.png', talking_image: '/static/N-talk.png'}}]
    ]) {
        test(route + ' uses the committed ' + modelType + ' identity across A/M → C/N → uncached D/N', async () => {
            windows.length = 0; queue.length = 0;
            const cards = {A: {model_type: 'vrm', vrm: '/Shared.vrm'}, C: card, D: card};
            const pageConfigs = Object.fromEntries(['C', 'D'].map(name => [name,
                {...pageConfig, success: true, lanlan_name: name}]));
            const follower = fixture(route, 'vrm', {cards, pageConfigs});
            await switchFollower(follower, 'C', 'A', 11);
            queue.length = 0;
            await switchFollower(follower, 'D', 'C', 12);
            const modelKey = modelType + ':' + modelPath;
            assert.deepEqual(scopedRequests(route, 'D').map(p => p.avatar_scope.modelKey), [modelKey]);
            const packet = {action:'avatar_updated', lanlan_name:'D', dataUrl:wrong, modelType, avatar_source:'pet',
                avatar_scope:{name:'D',revision:12,modelKey}};
            await follower.event({...packet, avatar_scope:{...packet.avatar_scope, modelKey:'vrm:/Shared.vrm'}});
            assert.equal(follower.dataUrl(), '', 'previous boot key must not accept a reply');
            await follower.event({...packet, avatar_scope:{...packet.avatar_scope, revision:11}});
            assert.equal(follower.dataUrl(), '', 'previous revision must not accept a reply');
            await follower.event({...packet, dataUrl:portraitA});
            assert.equal(follower.dataUrl(), portraitA);
            assert.deepEqual(follower.writes, []);
        });
    }
}

test('a delayed named model read cannot publish a superseded follower scope or delay chat commit', async () => {
    windows.length = 0; queue.length = 0;
    const slow = hold();
    const follower = fixture('/chat', 'vrm', {fromStorage:true, readPageConfig: name => name === 'B' ? slow.promise : null});
    await switchFollower(follower, 'B', 'A', 11);
    assert.equal(follower.dataUrl(), '');
    assert.equal(scopedRequests('/chat','B').length, 0, 'do not send the bootstrap key while B identity is pending');
    await switchFollower(follower, 'C', 'B', 12);
    assert.deepEqual(committedRevisions(follower), [12]);
    slow.release();
    await settleSwitch();
    assert.deepEqual(committedRevisions(follower), [12], 'late B must not supersede C');
    assert.equal(scopedRequests('/chat','B').length, 0);
    assert.deepEqual(follower.pageConfigReads, ['B', 'C']);
});

test('a latest same-name receipt starts a fresh lookup while the previous one is pending', async () => {
    windows.length = 0; queue.length = 0;
    const slow = hold();
    let reads = 0;
    const follower = fixture('/chat', 'vrm', {readPageConfig: () => ++reads === 1 ? slow.promise : null});
    await switchFollower(follower, 'B', 'A', 11);
    await queueSwitch(follower, 'B', 'B', 12);
    await settleSwitch();
    assert.deepEqual(committedRevisions(follower), [12]);
    assert.deepEqual(follower.commits, ['B'], 'a newer same-name receipt is not a chat reload');
    slow.release();
    await settleSwitch();
    assert.deepEqual(committedRevisions(follower), [12]);
    assert.deepEqual(follower.pageConfigReads, ['B', 'B']);
});

test('unverified named model never falls back to the prior boot path; a verified target cache avoids a request', async () => {
    windows.length = 0; queue.length = 0;
    const follower = fixture('/chat_full', 'vrm', {fromStorage:true, pageConfigs: {
        B: {success:true, lanlan_name:'A', model_type:'vrm', model_path:'/Shared.vrm'}
    }});
    follower.store.set('neko_avatar:C',JSON.stringify({
        dataUrl:wrong, modelType:'vrm', cacheKey:'vrm:/Shared.vrm',
    }));
    await switchFollower(follower,'B','A',11);
    assert.equal(follower.dataUrl(), '');
    assert.equal(scopedRequests('/chat_full','B').length, 0);
    await switchFollower(follower,'C','B',12);
    assert.equal(follower.dataUrl(),wrong);
    assert.equal(scopedRequests('/chat_full','C').length, 0);
    assert.deepEqual(follower.writes, []);
});

test('legacy unstamped follower switches still discard the old role and accept the named legacy portrait', async () => {
    windows.length = 0; queue.length = 0;
    const follower = fixture('/chat', 'vrm', {fromStorage:true});
    await switchFollower(follower,'B','A',0);
    assert.equal(follower.dataUrl(),'');
    assert.equal(scopedRequests('/chat','B').length,0);
    await follower.event({action:'avatar_updated', lanlan_name:'B', dataUrl:wrong, modelType:'vrm'});
    assert.equal(follower.dataUrl(),wrong);
    assert.deepEqual(follower.writes,[]);
});
