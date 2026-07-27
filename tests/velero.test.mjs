import test from 'node:test'
import assert from 'node:assert/strict'
import { backupResource, credentialsSecret, locationResource, restoreResource, scheduleResource } from '../src/velero.js'

test('backup is manifest-only with a 30-day default', () => {
  const value = backupResource({ name: 'nightly-default', namespaces: ['default'], storageLocation: 'cos' })
  assert.equal(value.spec.ttl, 'PT720H')
  assert.equal(value.spec.snapshotVolumes, false)
  assert.equal(value.spec.defaultVolumesToFsBackup, false)
})

test('restore uses safe collision and cluster-resource defaults', () => {
  const value = restoreResource({ name: 'restore-default', backupName: 'nightly-default', namespaces: ['default'], mapping: { default: 'restored' } })
  assert.equal(value.spec.existingResourcePolicy, 'none')
  assert.equal(value.spec.includeClusterResources, false)
  assert.deepEqual(value.spec.namespaceMapping, { default: 'restored' })
})

test('location references a credential without exposing it', () => {
  const location = locationResource({ name: 'cos', bucket: 'archives', region: 'ap-guangzhou', endpoint: 'https://cos.example.com', forcePathStyle: true, credentialName: 'cos-credentials' })
  const secret = credentialsSecret('cos-credentials', 'key', 'secret')
  assert.equal(location.spec.credential.key, 'cloud')
  assert.match(secret.stringData.cloud, /aws_secret_access_key=secret/)
  assert.equal(scheduleResource({ name: 'daily', cron: '0 2 * * *', storageLocation: 'cos' }).spec.template.snapshotVolumes, false)
})
