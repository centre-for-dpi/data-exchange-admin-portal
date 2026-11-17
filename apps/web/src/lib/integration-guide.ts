/**
 * The integration guide's snippets (M5-08): get a token and call an API with the DEN headers, in
 * curl, Python, Node.js, Java and C#. With mTLS (features.mtls.required) both calls present the
 * application's certificate and trust the gateway through the network CA: the token comes bound
 * to that certificate. Every program reads the secret from the environment (DEN_CLIENT_SECRET),
 * never from its source.
 */

export const GUIDE_LANGUAGES = ['curl', 'python', 'node', 'java', 'csharp'] as const;
export type GuideLanguage = (typeof GUIDE_LANGUAGES)[number];

export interface GuideInput {
  clientId: string;
  tokenUrl: string;
  gateway: string;
  mtls: boolean;
  /** Placeholders in the UI language: the path after the gateway, the purpose and the official. */
  path: string;
  purpose: string;
  endUser: string;
}

export interface Snippet {
  language: GuideLanguage;
  /** File name to save it as (and to run it). */
  file: string;
  code: string;
}

/** The PEM files the application keeps: its certificate, its key and the network CA. */
const files = (clientId: string) => ({
  cert: `${clientId}.crt`,
  key: `${clientId}.key`,
  ca: 'den-network-ca.pem',
});

function curl(i: GuideInput): string {
  const f = files(i.clientId);
  const tls = i.mtls ? [`  --cert ${f.cert} --key ${f.key} \\`, `  --cacert ${f.ca} \\`] : [];
  return [
    ...(i.mtls
      ? [
          '# curl with OpenSSL (Linux, macOS, WSL). On Windows the system curl (Schannel) takes the',
          '# certificate as a PFX file instead of --cert/--key.',
        ]
      : []),
    '# 1. Token (5 minutes). The secret comes from the environment: export DEN_CLIENT_SECRET=...',
    `TOKEN=$(curl -s -u "${i.clientId}:$DEN_CLIENT_SECRET" \\`,
    ...tls,
    '  -d grant_type=client_credentials \\',
    `  ${i.tokenUrl} | jq -r .access_token)`,
    '',
    '# 2. Call, with the purpose of the approved request and the official making it.',
    `curl ${i.gateway}${i.path} \\`,
    ...tls,
    '  -H "Authorization: Bearer $TOKEN" \\',
    `  -H "X-DEN-Purpose: ${i.purpose}" \\`,
    `  -H "X-DEN-End-User: ${i.endUser}"`,
  ].join('\n');
}

function python(i: GuideInput): string {
  const f = files(i.clientId);
  return [
    '# pip install requests',
    'import os',
    '',
    'import requests',
    '',
    `GATEWAY = "${i.gateway}"`,
    `TOKEN_URL = "${i.tokenUrl}"`,
    `CLIENT_ID = "${i.clientId}"`,
    'CLIENT_SECRET = os.environ["DEN_CLIENT_SECRET"]',
    ...(i.mtls
      ? [
          '# The application certificate (mTLS) and the network CA, for both calls.',
          `TLS = {"cert": ("${f.cert}", "${f.key}"), "verify": "${f.ca}"}`,
        ]
      : ['TLS = {}']),
    '',
    'token = requests.post(',
    '    TOKEN_URL,',
    '    data={"grant_type": "client_credentials"},',
    '    auth=(CLIENT_ID, CLIENT_SECRET),',
    '    timeout=10,',
    '    **TLS,',
    ').json()["access_token"]',
    '',
    'response = requests.get(',
    `    GATEWAY + "${i.path}",`,
    '    headers={',
    '        "Authorization": "Bearer " + token,',
    `        "X-DEN-Purpose": "${i.purpose}",`,
    `        "X-DEN-End-User": "${i.endUser}",`,
    '    },',
    '    timeout=10,',
    '    **TLS,',
    ')',
    'print(response.status_code, response.text)',
  ].join('\n');
}

function node(i: GuideInput): string {
  const f = files(i.clientId);
  return [
    '// Node.js 20+, as an ES module (den.mjs). npm install undici',
    ...(i.mtls ? ["import { readFileSync } from 'node:fs';"] : []),
    "import { Agent, fetch } from 'undici';",
    '',
    `const GATEWAY = '${i.gateway}';`,
    `const TOKEN_URL = '${i.tokenUrl}';`,
    `const CLIENT_ID = '${i.clientId}';`,
    'const CLIENT_SECRET = process.env.DEN_CLIENT_SECRET;',
    ...(i.mtls
      ? [
          '// The application certificate (mTLS) and the network CA, for both calls.',
          'const dispatcher = new Agent({',
          '  connect: {',
          `    cert: readFileSync('${f.cert}'),`,
          `    key: readFileSync('${f.key}'),`,
          `    ca: readFileSync('${f.ca}'),`,
          '  },',
          '});',
        ]
      : ['const dispatcher = new Agent();']),
    '',
    "const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');",
    'const tokenResponse = await fetch(TOKEN_URL, {',
    "  method: 'POST',",
    '  dispatcher,',
    "  headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },",
    "  body: 'grant_type=client_credentials',",
    '});',
    'const { access_token: token } = await tokenResponse.json();',
    '',
    `const response = await fetch(GATEWAY + '${i.path}', {`,
    '  dispatcher,',
    '  headers: {',
    '    authorization: `Bearer ${token}`,',
    `    'x-den-purpose': '${i.purpose}',`,
    `    'x-den-end-user': '${i.endUser}',`,
    '  },',
    '});',
    'console.log(`${response.status} ${await response.text()}`);',
  ].join('\n');
}

function java(i: GuideInput): string {
  const f = files(i.clientId);
  const p12 = `${i.clientId}.p12`;
  return [
    ...(i.mtls
      ? [
          '// Java 17+. The certificate and its key in one PKCS#12 file, once:',
          `//   openssl pkcs12 -export -in ${f.cert} -inkey ${f.key} -out ${p12} -passout env:DEN_P12_PASSWORD`,
        ]
      : ['// Java 17+.']),
    'import java.io.FileInputStream;',
    'import java.net.URI;',
    'import java.net.http.HttpClient;',
    'import java.net.http.HttpRequest;',
    'import java.net.http.HttpResponse;',
    'import java.nio.charset.StandardCharsets;',
    'import java.security.KeyStore;',
    'import java.security.cert.CertificateFactory;',
    'import java.util.Base64;',
    'import java.util.regex.Matcher;',
    'import java.util.regex.Pattern;',
    'import javax.net.ssl.KeyManagerFactory;',
    'import javax.net.ssl.SSLContext;',
    'import javax.net.ssl.TrustManagerFactory;',
    '',
    'public class DenClient {',
    `  static final String GATEWAY = "${i.gateway}";`,
    `  static final String TOKEN_URL = "${i.tokenUrl}";`,
    `  static final String CLIENT_ID = "${i.clientId}";`,
    '',
    '  public static void main(String[] args) throws Exception {',
    '    String secret = System.getenv("DEN_CLIENT_SECRET");',
    ...(i.mtls
      ? [
          '    // The application certificate (mTLS) and the network CA, for both calls.',
          '    char[] password = System.getenv("DEN_P12_PASSWORD").toCharArray();',
          '    KeyStore identity = KeyStore.getInstance("PKCS12");',
          `    try (FileInputStream in = new FileInputStream("${p12}")) {`,
          '      identity.load(in, password);',
          '    }',
          '    KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());',
          '    keys.init(identity, password);',
          '    KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType());',
          '    trust.load(null, null);',
          `    try (FileInputStream in = new FileInputStream("${f.ca}")) {`,
          '      trust.setCertificateEntry("den-network-ca", CertificateFactory.getInstance("X.509").generateCertificate(in));',
          '    }',
          '    TrustManagerFactory trusted = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());',
          '    trusted.init(trust);',
          '    SSLContext tls = SSLContext.getInstance("TLS");',
          '    tls.init(keys.getKeyManagers(), trusted.getTrustManagers(), null);',
          '    HttpClient http = HttpClient.newBuilder().sslContext(tls).build();',
        ]
      : ['    HttpClient http = HttpClient.newHttpClient();']),
    '',
    '    String basic = Base64.getEncoder()',
    '        .encodeToString((CLIENT_ID + ":" + secret).getBytes(StandardCharsets.UTF_8));',
    '    HttpRequest tokenRequest = HttpRequest.newBuilder(URI.create(TOKEN_URL))',
    '        .header("Authorization", "Basic " + basic)',
    '        .header("Content-Type", "application/x-www-form-urlencoded")',
    '        .POST(HttpRequest.BodyPublishers.ofString("grant_type=client_credentials"))',
    '        .build();',
    '    String body = http.send(tokenRequest, HttpResponse.BodyHandlers.ofString()).body();',
    '    // Use your JSON library (Jackson, Gson...); a pattern keeps this example dependency-free.',
    '    Matcher m = Pattern.compile("\\"access_token\\"\\\\s*:\\\\s*\\"([^\\"]+)\\"").matcher(body);',
    '    if (!m.find()) throw new IllegalStateException("No token: " + body);',
    '',
    `    HttpRequest call = HttpRequest.newBuilder(URI.create(GATEWAY + "${i.path}"))`,
    '        .header("Authorization", "Bearer " + m.group(1))',
    `        .header("X-DEN-Purpose", "${i.purpose}")`,
    `        .header("X-DEN-End-User", "${i.endUser}")`,
    '        .GET()',
    '        .build();',
    '    HttpResponse<String> response = http.send(call, HttpResponse.BodyHandlers.ofString());',
    '    System.out.println(response.statusCode() + " " + response.body());',
    '  }',
    '}',
  ].join('\n');
}

function csharp(i: GuideInput): string {
  const f = files(i.clientId);
  return [
    '// .NET 9+, top-level program (Program.cs).',
    'using System.Net.Http.Headers;',
    ...(i.mtls
      ? ['using System.Net.Security;', 'using System.Security.Cryptography.X509Certificates;']
      : []),
    'using System.Text;',
    'using System.Text.Json;',
    '',
    `const string Gateway = "${i.gateway}";`,
    `const string TokenUrl = "${i.tokenUrl}";`,
    `const string ClientId = "${i.clientId}";`,
    'var secret = Environment.GetEnvironmentVariable("DEN_CLIENT_SECRET");',
    '',
    'var handler = new HttpClientHandler();',
    ...(i.mtls
      ? [
          '// The application certificate (mTLS) and the network CA, for both calls.',
          `using var pem = X509Certificate2.CreateFromPemFile("${f.cert}", "${f.key}");`,
          '// Through PKCS#12 so the key works with every TLS stack (SChannel on Windows).',
          'var clientCertificate = X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pkcs12), null);',
          `var networkCa = X509Certificate2.CreateFromPem(File.ReadAllText("${f.ca}"));`,
          'handler.ClientCertificateOptions = ClientCertificateOption.Manual;',
          'handler.ClientCertificates.Add(clientCertificate);',
          'handler.ServerCertificateCustomValidationCallback = (_, certificate, chain, errors) =>',
          '{',
          '    if (certificate is null || chain is null) return false;',
          '    chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;',
          '    chain.ChainPolicy.CustomTrustStore.Add(networkCa);',
          '    chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;',
          '    return chain.Build(certificate) && (errors & ~SslPolicyErrors.RemoteCertificateChainErrors) == SslPolicyErrors.None;',
          '};',
        ]
      : []),
    'using var http = new HttpClient(handler);',
    '',
    'var tokenRequest = new HttpRequestMessage(HttpMethod.Post, TokenUrl)',
    '{',
    '    Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["grant_type"] = "client_credentials" }),',
    '};',
    'tokenRequest.Headers.Authorization = new AuthenticationHeaderValue(',
    '    "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{ClientId}:{secret}")));',
    'using var tokenResponse = await http.SendAsync(tokenRequest);',
    'var token = JsonDocument.Parse(await tokenResponse.Content.ReadAsStringAsync())',
    '    .RootElement.GetProperty("access_token").GetString();',
    '',
    `var call = new HttpRequestMessage(HttpMethod.Get, Gateway + "${i.path}");`,
    'call.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);',
    `call.Headers.Add("X-DEN-Purpose", "${i.purpose}");`,
    `call.Headers.Add("X-DEN-End-User", "${i.endUser}");`,
    'using var response = await http.SendAsync(call);',
    'Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");',
  ].join('\n');
}

const GENERATORS: Record<GuideLanguage, (i: GuideInput) => string> = {
  curl,
  python,
  node,
  java,
  csharp,
};

const FILES: Record<GuideLanguage, string> = {
  curl: 'den.sh',
  python: 'den.py',
  node: 'den.mjs',
  java: 'DenClient.java',
  csharp: 'Program.cs',
};

export function guideSnippets(input: GuideInput): Snippet[] {
  return GUIDE_LANGUAGES.map((language) => ({
    language,
    file: FILES[language],
    code: GENERATORS[language](input),
  }));
}
