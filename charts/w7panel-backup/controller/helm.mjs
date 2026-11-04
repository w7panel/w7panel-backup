import { gunzipSync } from 'node:zlib'
import { parseAllDocuments } from 'yaml'

export function releaseFromSecret(secret) {
  if (secret.type !== 'helm.sh/release.v1' || !secret.data?.release) throw new Error('Invalid Helm release Secret')
  const encoded = Buffer.from(secret.data.release, 'base64').toString()
  const release = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')))
  if (release.name !== secret.metadata.labels?.name || release.namespace !== secret.metadata.namespace) throw new Error('Helm release Secret identity mismatch')
  return release
}

function documents(source) {
  if (!source) return []
  return parseAllDocuments(source).map(document => {
    if (document.errors.length) throw document.errors[0]
    return document.toJS()
  }).flatMap(object => object?.kind === 'List' ? object.items || [] : [object]).filter(object => object?.apiVersion && object?.kind && object?.metadata?.name)
}

export function releaseObjects(release) {
  const sources = [{ text: release.manifest, optional: false }, ...(release.hooks || []).map(hook => ({ text: hook.manifest, optional: true }))]
  for (const file of release.chart?.files || []) {
    if (file.name?.startsWith('crds/')) sources.push({ text: Buffer.from(file.data, 'base64').toString(), optional: false })
  }
  return sources.flatMap(source => documents(source.text).map(object => ({
    apiVersion: object.apiVersion,
    kind: object.kind,
    namespace: object.metadata.namespace || release.namespace,
    name: object.metadata.name,
    optional: source.optional,
  })))
}
