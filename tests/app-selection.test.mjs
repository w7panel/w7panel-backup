import test from 'node:test'
import assert from 'node:assert/strict'
import { appKey, appObjects, labelId, markObjects, objectKey } from '../src/app-selection.js'
import { backupResource, restoreResource, scheduleResource } from '../src/velero.js'

test('AppGroup deployment manifest becomes a distinct selectable object list', async () => {
  const app = { apiVersion: 'w7panel.w7.com/v1alpha1', metadata: { namespace: 'default', name: 'shop' }, status: { deployInfo: [{ resourcesList: [
    { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web' },
    { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web' },
    { apiVersion: 'v1', kind: 'Service', namespace: 'other', name: 'web' },
  ] }] } }
  const objects = appObjects(app)
  assert.equal(appKey(app), 'default/shop')
  assert.equal(objects.length, 3)
  assert.equal(new Set(objects.map(objectKey)).size, 3)
  assert.equal((await labelId(objectKey(objects[1]))).length, 32)
})

test('single-object backup and restore selectors exclude unselected objects', () => {
  const backup = backupResource({ name: 'shop', namespaces: ['default'], storageLocation: 'local', objectIds: ['id-a'] })
  const restore = restoreResource({ name: 'shop-restore', backupName: 'shop', namespaces: ['default'], objectIds: ['id-a'] })
  assert.deepEqual(backup.spec.orLabelSelectors, [{ matchLabels: { 'backup.w7panel.io/object-id': 'id-a' } }])
  assert.deepEqual(restore.spec.orLabelSelectors, backup.spec.orLabelSelectors)
  assert.equal(backup.spec.includeClusterResources, true)
  assert.throws(() => backupResource({ name: 'empty', objectIds: [] }), /至少选择/)
})

test('app schedule includes future app resources but excludes unchecked identities', () => {
  const value = scheduleResource({ name: 'daily', cron: '0 2 * * *', namespaces: ['*'], storageLocation: 'local', appId: 'app-a', excludedObjectIds: ['obj-b'] })
  assert.deepEqual(value.spec.template.includedNamespaces, ['*'])
  assert.deepEqual(value.spec.template.labelSelector, { matchLabels: { 'backup.w7panel.io/app-app-a': 'true' }, matchExpressions: [{ key: 'backup.w7panel.io/object-id', operator: 'NotIn', values: ['obj-b'] }] })
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
    assert.equal(calls[1].url, '/k8s-proxy/apis/apps/v1/namespaces/default/deployments/web')
    const labels = JSON.parse(calls[1].options.body).metadata.labels
    assert.equal(labels[`backup.w7panel.io/app-${result.appId}`], 'true')
    assert.equal(labels['backup.w7panel.io/object-id'], result.objects[0].id)
  } finally { globalThis.fetch = originalFetch }
})
