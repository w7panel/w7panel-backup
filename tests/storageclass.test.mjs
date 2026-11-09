import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'

test('local S3 PVC storage class and access mode leave legacy MinIO unchanged', t => {
  if (spawnSync('helm', ['version', '--short']).error) return t.skip('helm is unavailable')
  const render = (...args) => {
    const result = spawnSync('helm', ['template', 'backup', 'charts/w7panel-backup', '--set', 'legacyMinio.enabled=true', ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return YAML.parseAllDocuments(result.stdout).map(doc => doc.toJS()).filter(doc => doc?.kind === 'PersistentVolumeClaim')
  }

  const defaultPvcs = render()
  assert.equal(defaultPvcs.find(pvc => pvc.metadata.name === 'backup-s3').spec.storageClassName, 'local-path')
  assert.deepEqual(defaultPvcs.find(pvc => pvc.metadata.name === 'backup-s3').spec.accessModes, ['ReadWriteOnce'])

  const selectedPvcs = render('--set', 'storageclass=longhorn')
  assert.equal(selectedPvcs.find(pvc => pvc.metadata.name === 'backup-s3').spec.storageClassName, 'longhorn')
  assert.equal(selectedPvcs.find(pvc => pvc.metadata.name === 'backup-minio').spec.storageClassName, 'local-path')

  const sharedPvcs = render('--set', 'storageclass=longhorn', '--set', 'localS3.accessMode=ReadWriteMany')
  assert.deepEqual(sharedPvcs.find(pvc => pvc.metadata.name === 'backup-s3').spec.accessModes, ['ReadWriteMany'])
  assert.deepEqual(sharedPvcs.find(pvc => pvc.metadata.name === 'backup-minio').spec.accessModes, ['ReadWriteOnce'])

  const invalid = spawnSync('helm', ['template', 'backup', 'charts/w7panel-backup', '--set', 'localS3.accessMode=ReadOnlyMany'], { encoding: 'utf8' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /localS3\.accessMode must be ReadWriteOnce or ReadWriteMany/)
})
