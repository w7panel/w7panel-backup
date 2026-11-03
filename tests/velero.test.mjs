import test from 'node:test'
import assert from 'node:assert/strict'
import { backupResource, downloadEndpointIssue, downloadRequestResource, isMicroappRuntime, localProxyPath, restoreLocationIssue, restoreResource, scheduleResource, veleroDeploymentPath, veleroPath } from '../src/velero.js'

test('localhost uses the Vite Kubernetes proxy path', () => {
  assert.equal(isMicroappRuntime(), false)
  assert.equal(localProxyPath('/api/v1/namespaces'), '/k8s-proxy/api/v1/namespaces')
  assert.throws(() => localProxyPath('//example.com'), /路径无效/)
})

test('backup is manifest-only with a 30-day default', () => {
  const value = backupResource({ name: 'nightly-default', namespaces: ['default'], storageLocation: 'cos' })
  assert.equal(value.spec.ttl, '720h0m0s')
  assert.equal(value.spec.snapshotVolumes, false)
  assert.equal(value.spec.defaultVolumesToFsBackup, false)
})

test('backup supports include and exclude namespace and resource scopes', () => {
  const selected = backupResource({ name: 'apps-only', namespaces: ['default'], resources: ['deployments.apps', 'services'], storageLocation: 'default' })
  assert.deepEqual(selected.spec.includedNamespaces, ['default'])
  assert.deepEqual(selected.spec.includedResources, ['deployments.apps', 'services'])
  const ignored = backupResource({ name: 'except-system', namespaces: ['kube-system'], namespaceMode: 'exclude', resources: ['secrets'], resourceMode: 'exclude', storageLocation: 'default' })
  assert.deepEqual(ignored.spec.excludedNamespaces, ['kube-system'])
  assert.deepEqual(ignored.spec.excludedResources, ['secrets'])
  assert.deepEqual(ignored.spec.includedNamespaces, ['*'])
})

test('download request targets the complete backup archive', () => {
  const request = downloadRequestResource({ name: 'download-123', backupName: 'nightly-default' })
  assert.equal(request.spec.target.kind, 'BackupContents')
  assert.equal(request.spec.target.name, 'nightly-default')
})

test('only a public HTTPS object-storage endpoint can serve browser downloads', () => {
  assert.equal(downloadEndpointIssue('https://cos.example.com'), '')
  assert.match(downloadEndpointIssue('http://w7panel-backup-minio:9000'), /HTTPS/)
  assert.match(downloadEndpointIssue('https://w7panel-backup-minio.default.svc'), /内网/)
  assert.match(downloadEndpointIssue('https://10.0.0.10'), /内网/)
})

test('restore uses safe collision and cluster-resource defaults', () => {
  const value = restoreResource({ name: 'restore-default', backupName: 'nightly-default', namespaces: ['default'], mapping: { default: 'restored' } })
  assert.equal(value.spec.existingResourcePolicy, 'none')
  assert.equal(value.spec.includeClusterResources, false)
  assert.deepEqual(value.spec.namespaceMapping, { default: 'restored' })
})

test('restore requires an available target storage location', () => {
  assert.equal(restoreLocationIssue({ metadata: { name: 'shared' }, status: { phase: 'Available' } }), '')
  assert.match(restoreLocationIssue({ metadata: { name: 'shared' }, status: { phase: 'Unavailable' } }), /不可用/)
})

test('storage-location patches target the namespaced Velero resource', () => {
  assert.equal(veleroPath('default', 'backupstoragelocations', 'cos'), '/apis/velero.io/v1/namespaces/default/backupstoragelocations/cos')
  assert.equal(veleroDeploymentPath('velero'), '/apis/apps/v1/namespaces/velero/deployments/velero')
})
