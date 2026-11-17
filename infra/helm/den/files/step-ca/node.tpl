{
  "subject": { "commonName": {{ toJson .Subject.CommonName }} },
  "sans": {{ toJson .SANs }},
  "keyUsage": ["digitalSignature"],
  "extKeyUsage": ["serverAuth", "clientAuth"],
  "basicConstraints": { "isCA": false }
}
