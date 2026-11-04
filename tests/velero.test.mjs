import test from 'node:test'
import assert from 'node:assert/strict'
import { backupResource, downloadEndpointIssue, downloadRequestResource, isMicroappRuntime, localProxyPath, locationCredential, locationReferences, locationResource, managedLocation, secretPath, writableLocation, restoreLocationIssue, restoreResource, scheduleResource, veleroDeploymentPath, veleroPath } from '../src/velero.js'

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


test('page-created S3 location uses its own credential without exposing the key in the location', () => {
  const form = { name: 'cos', bucket: 'backup-123', prefix: 'velero', endpoint: 'https://cos.ap-shanghai.myqcloud.com', region: 'ap-shanghai', forcePathStyle: false, accessMode: 'ReadWrite' }
  const location = locationResource(form)
  const credential = locationCredential(form.name, 'id', 'private-key')
  assert.equal(location.spec.config.s3ForcePathStyle, 'false')
  assert.equal(location.spec.objectStorage.prefix, 'velero')
  assert.equal(location.spec.credential.name, 'bsl-cos')
  assert.equal(JSON.stringify(location).includes('private-key'), false)
  assert.equal(credential.stringData.cloud, '[default]\naws_access_key_id=id\naws_secret_access_key=private-key')
  assert.equal(managedLocation(location), true)
  assert.equal(writableLocation({ ...location, status: { phase: 'Available' } }), true)
  assert.equal(writableLocation({ ...location, spec: { ...location.spec, accessMode: 'ReadOnly' }, status: { phase: 'Available' } }), false)
  assert.equal(secretPath('velero', 'bsl-cos'), '/api/v1/namespaces/velero/secrets/bsl-cos')
  assert.throws(() => locationResource({ ...form, endpoint: 'https://user:password@cos.example.com' }), /Endpoint/)
  assert.throws(() => locationCredential('cos', 'id', 'with\nnewline'), /换行/)
})

test('storage location deletion finds backup and schedule references', () => {
  const backups = [{ metadata: { name: 'one' }, spec: { storageLocation: 'cos' } }]
  const schedules = [{ metadata: { name: 'daily' }, spec: { template: { storageLocation: 'cos' } } }]
  assert.deepEqual(locationReferences('cos', backups, schedules), ['备份 one', '计划 daily'])
  assert.deepEqual(locationReferences('other', backups, schedules), [])
})
