// opencode-bedrock-rotate
//
// An opencode plugin that rotates multiple Amazon Bedrock bearer tokens (API
// keys) across accounts and automatically retries the same request with the
// next token when Bedrock throttles.
//
// It wraps the provider's HTTP `fetch` (injected via the auth `loader` hook),
// so it works with the released opencode binary — no rebuild required.
//
// Docs & usage: https://github.com/clopca/opencode-bedrock-rotate

const DEFAULT_TOKENS_ENV = "AWS_BEARER_TOKENS_BEDROCK"
const FALLBACK_TOKEN_ENV = "AWS_BEARER_TOKEN_BEDROCK"

function tokensFromOptions(options) {
  const list = options && options.tokens
  if (Array.isArray(list)) return normalize(list)
  if (typeof list === "string") return normalize(list.split(","))
  return undefined
}

function tokensFromEnv(options) {
  const envName = (options && options.tokensEnv) || DEFAULT_TOKENS_ENV
  const raw = process.env[envName] || process.env[FALLBACK_TOKEN_ENV] || ""
  return normalize(raw.split(","))
}

function normalize(list) {
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))]
}

function resolveTokens(options) {
  return tokensFromOptions(options) || tokensFromEnv(options)
}

function isThrottleText(input) {
  const text = String(input || "").toLowerCase()
  return (
    text.includes("throttlingexception") ||
    text.includes("toomanyrequest") ||
    text.includes("servicequotaexceeded") ||
    text.includes("too many tokens") ||
    text.includes("too many requests") ||
    text.includes("rate exceeded")
  )
}

function errorText(error) {
  if (error instanceof Error) return `${error.name} ${error.message} ${errorText(error.cause)}`
  if (typeof error !== "object" || error === null) return String(error ?? "")
  return [error.name, error.code, error.type, error.message, error.error, error.cause].map(errorText).join(" ")
}

function isThrottleError(error) {
  return isThrottleText(errorText(error))
}

async function isThrottleResponse(response) {
  if (response.status === 429) return true
  if (response.ok) return false
  const errorType = response.headers.get("x-amzn-errortype") || response.headers.get("x-amzn-error-type") || ""
  if (isThrottleText(errorType)) return true
  const body = await response.clone().text().catch(() => "")
  return isThrottleText(body)
}

function withToken(init, token) {
  // Rotate the token into whichever auth header the underlying SDK already
  // uses: `@ai-sdk/anthropic` (Bedrock Mantle Anthropic path) sends `x-api-key`,
  // while `@ai-sdk/amazon-bedrock` (native runtime) sends `Authorization:
  // Bearer`. Never send both, or Bedrock rejects the request.
  const headers = new Headers(init && init.headers)
  if (headers.has("x-api-key")) headers.set("x-api-key", token)
  else headers.set("authorization", `Bearer ${token}`)
  return { ...(init || {}), headers }
}

function createRotatingFetch(options) {
  let next = 0
  return async (input, init) => {
    const tokens = resolveTokens(options)
    if (tokens.length === 0) return fetch(input, init)

    const start = next % tokens.length
    let throttledResponse
    let throttledError

    for (let offset = 0; offset < tokens.length; offset++) {
      const token = tokens[(start + offset) % tokens.length]
      try {
        const response = await fetch(input, withToken(init, token))
        if (!(await isThrottleResponse(response))) {
          next = (start + offset + 1) % tokens.length
          return response
        }
        throttledResponse = response
      } catch (error) {
        if (!isThrottleError(error)) throw error
        throttledError = error
      }
    }

    if (throttledResponse) return throttledResponse
    throw throttledError
  }
}

// Provider ids that always exist in the models.dev catalog, so registering auth
// for them can never trigger opencode's toPublicInfo(undefined) crash.
const ALWAYS_IN_CATALOG = new Set(["amazon-bedrock"])

// Best-effort lookup of the provider ids present in the resolved config. Uses
// the safe `/config` endpoint (not `/config/providers`, which is the one that
// crashes). Fails open (returns undefined) on any error or timeout.
async function configuredProviderIds(client) {
  if (!client || !client.config || typeof client.config.get !== "function") return undefined
  try {
    const res = await Promise.race([
      Promise.resolve(client.config.get()),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 3000)),
    ])
    const cfg = res && (res.data ?? res)
    const provider = cfg && cfg.provider
    if (provider && typeof provider === "object") return new Set(Object.keys(provider))
    return undefined
  } catch {
    return undefined
  }
}

/**
 * opencode server plugin entrypoint.
 *
 * Config options (opencode.json):
 *   ["opencode-bedrock-rotate", {
 *     "provider": "amazon-bedrock",           // provider id to attach to (default)
 *     "tokensEnv": "AWS_BEARER_TOKENS_BEDROCK", // env var with comma-separated tokens (default)
 *     "tokens": ["tok1", "tok2"]              // or pass tokens inline (overrides env)
 *   }]
 *
 * To rotate for more than one provider id, list the plugin once per provider.
 */
export const BedrockRotate = async (input, options) => {
  const provider = (options && options.provider) || "amazon-bedrock"

  // Guard against opencode's "JSON Parse error: Unexpected identifier undefined"
  // crash, which happens when a plugin registers auth for a provider id that is
  // not in the catalog while a stored credential exists for it. If the provider
  // isn't configured (and isn't a known catalog id), warn and register nothing.
  const configured = await configuredProviderIds(input && input.client)
  if (configured && !configured.has(provider) && !ALWAYS_IN_CATALOG.has(provider)) {
    console.warn(
      `[opencode-bedrock-rotate] provider "${provider}" is not defined in your config; ` +
        `skipping bearer-token rotation for it. Add it under "provider" in opencode.json to enable.`,
    )
    return {}
  }

  const rotatingFetch = createRotatingFetch(options)

  return {
    auth: {
      provider,
      methods: [{ type: "api", label: "Amazon Bedrock API key (bearer token)" }],
      loader: async () => {
        const tokens = resolveTokens(options)
        return { fetch: rotatingFetch, ...(tokens[0] ? { apiKey: tokens[0] } : {}) }
      },
    },
  }
}

export default { id: "opencode-bedrock-rotate", server: BedrockRotate }
