import test from 'node:test'
import assert from 'node:assert/strict'
import { annotatedApps, appKey, appObjects, labelId, liveAppObjects, loadArchiveObjects, markObjects, objectKey, selectedUnion, uniqueObjects } from '../src/app-selection.js'
import { backupResource, restoreResource, scheduleResource } from '../src/velero.js'

test('AppGroup deployment manifest becomes a distinct selectable object list', async () => {
  const app = { apiVersion: 'w7panel.w7.com/v1alpha1', metadata: { namespace: 'default', name: 'shop' }, status: { deployInfo: [{ resourcesList: [
    { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web' },
    { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web' },
    { apiVersion: 'v1', kind: 'Service', namespace: 'other', name: 'web' },
  ] }], items: [{ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', name: 'web' }] } }
  const objects = appObjects(app)
  assert.equal(appKey(app), 'default/shop')
  assert.equal(objects.length, 4)
  assert.equal(new Set(objects.map(objectKey)).size, 4)
  assert.equal((await labelId(objectKey(objects[1]))).length, 32)
  assert.equal(await labelId('abc'), 'ba7816bf8f01cfea414140de5dae2223')
})

test('multiple AppGroups merge shared resources and old annotations remain readable', () => {
  const shared = { apiVersion: 'v1', kind: 'Service', namespace: 'default', name: 'web' }
  assert.deepEqual(uniqueObjects([shared, shared]).map(objectKey), ['v1/Service/default/web'])
  assert.deepEqual(annotatedApps({ 'backup.w7panel.io/appgroups': '["default/shop","other/api"]' }), ['default/shop', 'other/api'])
  assert.deepEqual(annotatedApps({ 'backup.w7panel.io/app-namespace': 'default', 'backup.w7panel.io/app-name': 'shop' }), ['default/shop'])
})

test('app labels hash without browser crypto.subtle on HTTP previews', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
  try { assert.equal(await labelId('default/中文'), '7d1dfdc437738ada8f06d77fa2afc18c') }
  finally { if (original) Object.defineProperty(globalThis, 'crypto', original); else delete globalThis.crypto }
})

test('restore reads its object index through the host Service proxy', async () => {
  const originalWindow = globalThis.window
  const calls = []
  globalThis.window = { __POWERED_BY_WUJIE__: true, $wujie: { props: { panelProxy: async path => {
    calls.push(path)
    return Response.json({ items: [{ name: 'shop' }] })
  } } } }
  try {
    assert.deepEqual(await loadArchiveObjects('default', 'backup-1'), { items: [{ name: 'shop' }] })
    assert.deepEqual(calls, ['/namespaces/default/services/w7panel-backup-index:8080/proxy-root/v1/backups/backup-1/objects'])
    globalThis.window.$wujie.props.panelProxy = async () => Response.json({ message: 'index unavailable' }, { status: 503 })
    await assert.rejects(() => loadArchiveObjects('default', 'backup-1'), /index unavailable/)
  } finally { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow }
})

test('local preview keeps its direct index proxy', async () => {
  const originalFetch = globalThis.fetch
  let requestedPath
  globalThis.fetch = async path => { requestedPath = path; return Response.json({ items: [] }) }
  try {
    assert.deepEqual(await loadArchiveObjects('default', 'backup-1'), { items: [] })
    assert.equal(requestedPath, '/k8s-proxy/api/v1/namespaces/default/services/w7panel-backup-index/proxy/v1/backups/backup-1/objects')
  } finally { globalThis.fetch = originalFetch }
})

test('adding and removing apps keeps manual deselections and selects only new resources', () => {
  const a = { apiVersion: 'v1', kind: 'Service', namespace: 'default', name: 'a' }
  const shared = { apiVersion: 'v1', kind: 'Service', namespace: 'default', name: 'shared' }
  const b = { apiVersion: 'v1', kind: 'Service', namespace: 'other', name: 'b' }
  assert.deepEqual(selectedUnion([a, shared], [objectKey(a)], [a, shared, shared, b]), [objectKey(a), objectKey(b)])
  assert.deepEqual(selectedUnion([a, shared, b], [objectKey(a), objectKey(b)], [shared, b]), [objectKey(b)])
})

test('live app resources come from the shared index service', async () => {
  const app = { apiVersion: 'w7panel.w7.com/v1alpha1', metadata: { namespace: 'default', name: 'shop' }, status: { deployInfo: [{ resourcesList: [{ apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web' }] }] } }
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async url => { calls.push(url); return Response.json({ items: [{ apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web' }] }) }
  try {
    assert.deepEqual((await liveAppObjects(app)).map(objectKey), ['apps/v1/Deployment/default/web'])
    assert.deepEqual(calls, ['/k8s-proxy/api/v1/namespaces/default/services/w7panel-backup-index/proxy/v1/apps/default/shop/objects'])
  } finally { globalThis.fetch = originalFetch }
})

test('single-object backup and restore selectors exclude unselected objects', () => {
  const backup = backupResource({ name: 'shop', namespaces: ['default'], storageLocation: 'local', objectIds: ['id-a'] })
  const restore = restoreResource({ name: 'shop-restore', backupName: 'shop', namespaces: ['default'], objectIds: ['id-a'] })
  assert.deepEqual(backup.spec.orLabelSelectors, [{ matchLabels: { 'backup.w7panel.io/object-id': 'id-a' } }])
  assert.deepEqual(restore.spec.orLabelSelectors, backup.spec.orLabelSelectors)
  assert.equal(backup.spec.includeClusterResources, true)
  assert.throws(() => backupResource({ name: 'empty', objectIds: [] }), /至少选择/)
  assert.equal(restore.metadata.annotations['backup.w7panel.io/hydrate-appgroups'], 'true')
})

test('app schedule includes future app resources but excludes unchecked identities', () => {
  const value = scheduleResource({ name: 'daily', cron: '0 2 * * *', namespaces: ['*'], storageLocation: 'local', appId: 'app-a', excludedObjectIds: ['obj-b'] })
  assert.deepEqual(value.spec.template.includedNamespaces, ['*'])
  assert.deepEqual(value.spec.template.labelSelector, { matchLabels: { 'backup.w7panel.io/app-app-a': 'true' }, matchExpressions: [{ key: 'backup.w7panel.io/object-id', operator: 'NotIn', values: ['obj-b'] }] })
})

test('multi-app schedule ORs app labels and excludes unchecked shared identities', () => {
  const value = scheduleResource({ name: 'daily', cron: '0 2 * * *', namespaces: ['*'], storageLocation: 'local', appIds: ['a', 'b'], excludedObjectIds: ['shared'] })
  assert.deepEqual(value.spec.template.orLabelSelectors, ['a', 'b'].map(id => ({ matchLabels: { [`backup.w7panel.io/app-${id}`]: 'true' }, matchExpressions: [{ key: 'backup.w7panel.io/object-id', operator: 'NotIn', values: ['shared'] }] })))
})

test('selected objects receive an app-specific label before backup', async () => {
  const app = { metadata: { namespace: 'default', name: 'shop' } }
  const object = { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web' }
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => options.method === 'PATCH' ? {} : { resources: [{ kind: 'Deployment', name: 'deployments', namespaced: true, verbs: ['patch'] }] } }
  }
  try {
    const result = await markObjects(app, [object])
    assert.equal(result.objects.length, 1)
    const patch = calls.find(call => call.options.method === 'PATCH')
    assert.equal(patch.url, '/k8s-proxy/apis/apps/v1/namespaces/default/deployments/web')
    const labels = JSON.parse(patch.options.body).metadata.labels
    assert.equal(labels[`backup.w7panel.io/app-${result.appId}`], 'true')
    assert.equal(labels['backup.w7panel.io/object-id'], result.objects[0].id)
  } finally { globalThis.fetch = originalFetch }
})
