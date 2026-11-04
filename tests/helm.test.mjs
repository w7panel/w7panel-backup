import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { releaseFromSecret, releaseObjects } from '../charts/w7panel-backup/controller/helm.mjs'

test('Helm Secret yields rendered, hook, and Chart CRD objects', () => {
  const release = {
    name: 'shop', namespace: 'default', version: 3,
    manifest: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: shop-reader\n',
    hooks: [{ manifest: 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: install-check\n' }],
    chart: { files: [{ name: 'crds/shop.yaml', data: Buffer.from('apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: shops.example.com\n').toString('base64') }] },
  }
  const encoded = gzipSync(JSON.stringify(release)).toString('base64')
  const secret = { type: 'helm.sh/release.v1', metadata: { namespace: 'default', labels: { name: 'shop' } }, data: { release: Buffer.from(encoded).toString('base64') } }
  const decoded = releaseFromSecret(secret)
  assert.equal(decoded.version, 3)
  assert.deepEqual(releaseObjects(decoded).map(object => `${object.kind}/${object.name}`), [
    'Deployment/web', 'ClusterRole/shop-reader', 'Job/install-check', 'CustomResourceDefinition/shops.example.com',
  ])
  assert.throws(() => releaseFromSecret({ ...secret, metadata: { ...secret.metadata, labels: { name: 'other' } } }), /identity mismatch/)
})

test('rendered Helm Jobs may be absent after they finish', () => {
  const objects = releaseObjects({ namespace: 'default', manifest: 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: upgrade\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n' })
  assert.equal(objects.find(object => object.kind === 'Job').optional, true)
  assert.equal(objects.find(object => object.kind === 'Deployment').optional, false)
})
