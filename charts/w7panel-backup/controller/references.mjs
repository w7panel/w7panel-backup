const workloads = new Set(['Deployment', 'StatefulSet', 'DaemonSet'])

export function referencedObjects(workload) {
  if (!workloads.has(workload.kind) || !workload.metadata?.namespace) return []
  const pod = workload.spec?.template?.spec
  if (!pod) return []
  const found = new Map()
  const add = (kind, name) => {
    if (!name) return
    const object = { apiVersion: 'v1', kind, namespace: workload.metadata.namespace, name }
    found.set(`${kind}/${name}`, object)
  }

  for (const volume of pod.volumes || []) {
    add('ConfigMap', volume.configMap?.name)
    add('Secret', volume.secret?.secretName)
    add('Secret', volume.csi?.nodePublishSecretRef?.name)
    for (const source of volume.projected?.sources || []) {
      add('ConfigMap', source.configMap?.name)
      add('Secret', source.secret?.name)
    }
  }
  for (const ref of pod.imagePullSecrets || []) add('Secret', ref.name)
  for (const container of [...(pod.initContainers || []), ...(pod.containers || []), ...(pod.ephemeralContainers || [])]) {
    for (const source of container.envFrom || []) {
      add('ConfigMap', source.configMapRef?.name)
      add('Secret', source.secretRef?.name)
    }
    for (const variable of container.env || []) {
      add('ConfigMap', variable.valueFrom?.configMapKeyRef?.name)
      add('Secret', variable.valueFrom?.secretKeyRef?.name)
    }
  }
  return [...found.values()]
}
