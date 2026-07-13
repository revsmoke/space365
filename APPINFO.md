Space3365 Microsoft Entra Application


Display name
space365.tpgarchitecture.com
Application (client) ID
c0c22d69-599d-4e47-8e42-502033f70996
Object ID
ca948c8b-f3d7-4722-a530-6058375374f0
Directory (tenant) ID
ddd9f933-04a5-43f0-8673-5933da46cdcb
Supported account types
My organization only

Client credentials
0 certificate, 1 secret
Redirect URIs
9 web, 0 spa, 0 public client
Application ID URI
Add an Application ID URI
Managed application in local directory
space365.tpgarchitecture.com


## Authentication

| Platform Type | Redirect URI                                   |
|---------------|------------------------------------------------|
| Web           | http://localhost/auth                          |
| Web           | http://localhost/index.cfm                     |
| Web           | http://localhost                               |
| Web           | https://localhost/auth                         |
| Web           | https://localhost/index.cfm                    |
| Web           | https://localhost                              |
| Web           | https://space365.tpgarchitecture.com/auth      |
| Web           | https://space365.tpgarchitecture.com/index.cfm |
| Web           | https://space365.tpgarchitecture.com           |

### Microsoft Graph Application object

```json
{
  "web": {
    "redirectUris": [
      "http://localhost",
      "http://localhost/auth",
      "http://localhost/index.cfm",
      "https://localhost",
      "https://localhost/auth",
      "https://localhost/index.cfm",
      "https://space365.tpgarchitecture.com",
      "https://space365.tpgarchitecture.com/auth",
      "https://space365.tpgarchitecture.com/index.cfm"
    ]
  }
}
```

### App manifest “replyUrlsWithType” shape (Azure AD Graph format tab)

```
{
  "replyUrlsWithType": [
    { "url": "http://localhost", "type": "Web" },
    { "url": "http://localhost/auth", "type": "Web" },
    { "url": "http://localhost/index.cfm", "type": "Web" },
    { "url": "https://localhost", "type": "Web" },
    { "url": "https://localhost/auth", "type": "Web" },
    { "url": "https://localhost/index.cfm", "type": "Web" },
    { "url": "https://space365.tpgarchitecture.com", "type": "Web" },
    { "url": "https://space365.tpgarchitecture.com/auth", "type": "Web" },
    { "url": "https://space365.tpgarchitecture.com/index.cfm", "type": "Web" }
  ]
}
```

```json
{
  "platformType": "web",
  "redirectUris": {
    "local_http": [
      "http://localhost",
      "http://localhost/auth",
      "http://localhost/index.cfm"
    ],
    "local_https": [
      "https://localhost",
      "https://localhost/auth",
      "https://localhost/index.cfm"
    ],
    "production": [
      "https://space365.tpgarchitecture.com",
      "https://space365.tpgarchitecture.com/auth",
      "https://space365.tpgarchitecture.com/index.cfm"
    ]
  }
}
```

```yaml
platformType: web
redirectUris:
  local_http:
    - http://localhost
    - http://localhost/auth
    - http://localhost/index.cfm
  local_https:
    - https://localhost
    - https://localhost/auth
    - https://localhost/index.cfm
  production:
    - https://space365.tpgarchitecture.com
    - https://space365.tpgarchitecture.com/auth
    - https://space365.tpgarchitecture.com/index.cfm
```
Front-channel logout URL:

Full Production URL logout:
https://space365.tpgarchitecture.com/logout/

Local Dev: 
`./logout/`

### Client certificate

-----BEGIN CERTIFICATE-----
MIIGTTCCBTWgAwIBAgIQA+K/70ZCPqURUaQrHt9G/DANBgkqhkiG9w0BAQsFADCB
jzELMAkGA1UEBhMCR0IxGzAZBgNVBAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4G
A1UEBxMHU2FsZm9yZDEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQD
Ey5TZWN0aWdvIFJTQSBEb21haW4gVmFsaWRhdGlvbiBTZWN1cmUgU2VydmVyIENB
MB4XDTI1MDEzMDAwMDAwMFoXDTI2MDMwMjIzNTk1OVowIjEgMB4GA1UEAxMXd3d3
LnRwZ2FyY2hpdGVjdHVyZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQCzRrQYGNYqtsvnjN/BxXSWycz5V6aPkiaGseVmdLBQoDoWhds78GXnbx/V
Lz7w5aIIe/A9gLdoFLRjSj9e2q2HeFzrQMPcInsmFO8mR/l5oPsD199hT9NQPzqa
yqvlIKhHIRotazirxbM0zrvDgVrAyq5bcC6FyH6OUZpJLYyuKMCY/OCbt7r6WKit
BgyHXo0MMt72An3Kcrs6NRfwpen5vkgdVOH/5LAP4WPYbGEt+Wf9wz96qcbTKKz+
bkkQTQRapkMIOgD9YgHEsLPYS4bS99B+xBfJmsyBEArgl+ymzIIDoliZDbbLx63r
extYl2dT78qyThpUTGeacQ987OmVAgMBAAGjggMPMIIDCzAfBgNVHSMEGDAWgBSN
jF7EVK2K4Xfpm/mbBeG4AY1h4TAdBgNVHQ4EFgQUdrERPhejLUF3t0MDqsi46nEA
9RcwDgYDVR0PAQH/BAQDAgWgMAwGA1UdEwEB/wQCMAAwHQYDVR0lBBYwFAYIKwYB
BQUHAwEGCCsGAQUFBwMCMEkGA1UdIARCMEAwNAYLKwYBBAGyMQECAgcwJTAjBggr
BgEFBQcCARYXaHR0cHM6Ly9zZWN0aWdvLmNvbS9DUFMwCAYGZ4EMAQIBMIGEBggr
BgEFBQcBAQR4MHYwTwYIKwYBBQUHMAKGQ2h0dHA6Ly9jcnQuc2VjdGlnby5jb20v
U2VjdGlnb1JTQURvbWFpblZhbGlkYXRpb25TZWN1cmVTZXJ2ZXJDQS5jcnQwIwYI
KwYBBQUHMAGGF2h0dHA6Ly9vY3NwLnNlY3RpZ28uY29tMDcGA1UdEQQwMC6CF3d3
dy50cGdhcmNoaXRlY3R1cmUuY29tghN0cGdhcmNoaXRlY3R1cmUuY29tMIIBfwYK
KwYBBAHWeQIEAgSCAW8EggFrAWkAdgCWl2S/VViXrfdDh2g3CEJ36fA61fak8zZu
RqQ/D8qpxgAAAZS5BAHxAAAEAwBHMEUCIQDa6uTV1EEf+qch2Vi3zImndRiEv4SE
McDF1ZiBQQedvgIgU9nU4rV1mnEK/axCaYclYaxHQnnYtLTUK3V3Sca5sZQAdwAZ
htTHKKpv/roDb3gqTQGRqs4tcjEPrs5dcEEtJUzH1AAAAZS5BAGEAAAEAwBIMEYC
IQCPgs5oMuOsC/fac+fw2gqGdXi+f0OrtwezMKGEn0GCWwIhAMmveOTwU206BbV8
7Sye9L6U1i5nOmugTc2QYNc/Q/4OAHYAyzj3FYl8hKFEX1vB3fvJbvKaWc1HCmkF
hbDLFMMUWOcAAAGUuQQBzQAABAMARzBFAiAIfZb2KN87+yQtAaaB9EebfR0BJLgw
xVZRLj1Q+VZ8+AIhAMvOVbDAQQ76mgwnHInxjPH+ASUdKG6hudn9+UaSziiYMA0G
CSqGSIb3DQEBCwUAA4IBAQCl5HTcHkTbYTOjPu6eSNcHQYnYgHpvHoEqkaBfrfKV
8fvUZRcnKEKV/19q1YXarUUGVFPzv3Y2duJJrf1vX5dJFt+MKHyyQXrgi4wY+OER
0GxCnqLtnznscn/254dl7+jPoAHUovBdhk1+hIfCk0jtyS8+3UmsA1MjIT3Tdcvu
tp8ESbcfzwS50574RY0pgDpLkT8dVRbGCN8isBFgmKr1kpHxivwFPDVdxiCcSH+M
q5w+p1vyKibb1PxOzfPYuGMeuXiHD2p37+AfscDnb8xP6Vldl/oaoJLomjKb7LJT
4yKYupOzkSU0uWpWTpgM11MGIxgPgfoCCM4YBFHz8o/I
-----END CERTIFICATE-----

`./ssl_certs/www_tpgarchitecture_com.crt`
