import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client";
import type { OAuthClientInformation } from "@modelcontextprotocol/client";
import { getAuthorizationServerUrl } from "./discovery.js";
import type { BaseOAuthClientProvider } from "./providers.js";

/**
 * When the authorization server supports URL-based client IDs (SEP-991 / CIMD),
 * pre-register `{ client_id: clientMetadataUrl }` before SDK `auth()`.
 *
 * SDK `auth()` rejects non-HTTPS `clientMetadataUrl` during registration, but
 * accepts an already-stored `client_id` (including `http://` URLs used by local
 * dev/test metadata servers). Production CIMD metadata documents should still
 * use HTTPS per SEP-991.
 *
 * `resourceMetadataUrl` is the RFC 9728 document advertised by the
 * `WWW-Authenticate` challenge, when the caller has one. It matters here and
 * not only in `auth()`: this runs *before* SDK `auth()`, so without it the
 * pre-registration probe would do its own default-location discovery and miss
 * a document served from a non-default path (#2071).
 */
export async function ensureCimdClientRegistration(params: {
  serverUrl: string;
  provider: BaseOAuthClientProvider;
  fetchFn?: typeof fetch;
  resourceMetadataUrl?: URL;
}): Promise<void> {
  const clientMetadataUrl = params.provider.clientMetadataUrl?.trim();
  if (!clientMetadataUrl) return;

  const existing = await params.provider.clientInformation();
  if (existing?.client_id) return;

  let resourceMetadata;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      params.serverUrl,
      { resourceMetadataUrl: params.resourceMetadataUrl },
      // The same fetch the AS-metadata leg below uses. On web that is
      // `createRemoteFetch`, which proxies through the backend to sidestep
      // CORS — on the global `fetch` this leg would fail in the browser, be
      // swallowed by the catch, and leave CIMD probing the wrong
      // authorization server (Copilot).
      params.fetchFn,
    );
  } catch {
    resourceMetadata = undefined;
  }

  const authServerUrl = getAuthorizationServerUrl(
    params.serverUrl,
    resourceMetadata,
  );

  const metadata = await discoverAuthorizationServerMetadata(authServerUrl, {
    ...(params.fetchFn && { fetchFn: params.fetchFn }),
  });
  if (!metadata?.client_id_metadata_document_supported) return;

  const clientInformation: OAuthClientInformation = {
    client_id: clientMetadataUrl,
  };
  await params.provider.saveClientInformation(clientInformation, {
    registrationKind: "cimd",
  });
}
