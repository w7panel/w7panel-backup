import test from 'node:test'
import assert from 'node:assert/strict'
import { referencedObjects } from '../charts/w7panel-backup/controller/references.mjs'

for (const kind of ['Deployment', 'StatefulSet', 'DaemonSet']) {
  test(`${kind} pod references include direct ConfigMaps and Secrets once`, () => {
    const workload = { kind, metadata: { namespace: 'shop' }, spec: { template: { spec: {
      volumes: [
        { configMap: { name: 'settings' } }, { secret: { secretName: 'tls' } },
        { projected: { sources: [{ configMap: { name: 'settings' } }, { secret: { name: 'token' } }] } },
        { csi: { nodePublishSecretRef: { name: 'storage' } } }, { persistentVolumeClaim: { claimName: 'data' } },
      ],
      serviceAccountName: 'shop',
      imagePullSecrets: [{ name: 'registry' }],
      initContainers: [{ envFrom: [{ configMapRef: { name: 'init' } }] }],
      containers: [{ envFrom: [{ secretRef: { name: 'tls' } }], env: [
        { valueFrom: { configMapKeyRef: { name: 'settings' } } },
        { valueFrom: { secretKeyRef: { name: 'password' } } },
      ] }],
    } } } }
    assert.deepEqual(referencedObjects(workload), [
      { apiVersion: 'v1', kind: 'ConfigMap', namespace: 'shop', name: 'settings' },
      { apiVersion: 'v1', kind: 'Secret', namespace: 'shop', name: 'tls' },
      { apiVersion: 'v1', kind: 'Secret', namespace: 'shop', name: 'token' },
      { apiVersion: 'v1', kind: 'Secret', namespace: 'shop', name: 'storage' },
      { apiVersion: 'v1', kind: 'PersistentVolumeClaim', namespace: 'shop', name: 'data' },
      { apiVersion: 'v1', kind: 'ServiceAccount', namespace: 'shop', name: 'shop' },
      { apiVersion: 'v1', kind: 'Secret', namespace: 'shop', name: 'registry' },
      { apiVersion: 'v1', kind: 'ConfigMap', namespace: 'shop', name: 'init' },
      { apiVersion: 'v1', kind: 'Secret', namespace: 'shop', name: 'password' },
    ])
    assert.deepEqual(referencedObjects({ ...workload, kind: 'Job' }), referencedObjects(workload))
  })
}
