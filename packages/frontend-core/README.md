# `frontend-core`

Browser-focused utilities shared by Svelte applications. The helpers wrap session persistence, JWT decoding, and TOTP QR generation so that the ERP app and marketing admin UIs can rely on a single implementation.

## Highlights

* **Session manager** – Read/write user sessions from `localStorage`, refresh expirations, and expose normalized session objects built from raw JWT payloads.【F:packages/frontend-core/src/storage/index.ts†L1-L53】
* **Token helpers** – `getTokenData` mirrors the backend logic to turn raw tokens into the typed `UserSession` consumed across apps.【F:packages/frontend-core/src/storage/index.ts†L55-L70】
* **Shared schemas** – Zod definitions for token payloads and session data ensure runtime validation when working with decoded JWTs.【F:packages/frontend-core/src/types/index.ts†L1-L27】
* **Authenticator QR codes** – Generate otpauth URLs and PNG data URIs for onboarding new TOTP secrets inside the UI.【F:packages/frontend-core/src/auth/index.ts†L1-L17】

## Usage

Install the package via the workspace and import utilities where needed:

```ts
import { Session } from "frontend-core";

const session = Session.getFromLocalStorage();
if (!session) {
  Session.clearFromLocalStorage();
}
```

To display a QR code for two-factor enrollment:

```ts
import { generateAuthenticatorQRCode } from "frontend-core";

const qrCode = await generateAuthenticatorQRCode(secret, username);
```

## Scripts

This package provides helpers only; run linting or tests from the parent repository if you modify the code.
