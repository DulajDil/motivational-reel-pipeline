# Meta onboarding

> ## ⚠️ Verify everything in this document against official Meta documentation
>
> Meta changes permissions, app-review requirements, account eligibility, rate
> limits, Graph API versions and Reel specifications regularly, and without
> notice to integrators. **Every endpoint path, field name, permission and limit
> referenced in this repository is configuration, not truth.**
>
> Before you connect a real account, and again before every production release,
> check the current Meta developer documentation and reconcile it with:
>
> - `META_GRAPH_API_VERSION` in your configuration
> - the request builders in `services/providers/src/publisher/payloads.ts`
> - the video constraints in `renderer/src/profiles.ts`
>
> If something in this repository disagrees with Meta's documentation, Meta is
> right and this repository is stale.

---

## What API publishing is, and is not

**It is:** a server-to-server integration for **eligible professional accounts** —
an Instagram Professional account (Business or Creator) linked to a Facebook Page
you manage, through a Meta app that has been granted the relevant permissions.

**It is not:**

- a way to post from a personal Instagram or Facebook account,
- a replacement for the Instagram or Facebook app,
- a route to Meta's in-app music library. **Tracks offered inside the Instagram
  and Facebook apps cannot be selected programmatically, and their licences do
  not extend to audio this system mixes into an MP4.** See
  [`music-rights.md`](music-rights.md).

If your goal depends on in-app music, API publishing will not deliver it. Render
silent, or use a track you own or have licensed.

---

## Prerequisites checklist

Work top to bottom. Each step gates the next.

### 1. Accounts

- [ ] A **Facebook Page** you administer.
- [ ] An **Instagram Professional account** (Business or Creator), not a personal
      account.
- [ ] The Instagram account **linked to that Page**. Verify the link from the
      Page's settings, not just from the Instagram app.
- [ ] Confirm the accounts are **eligible to publish Reels via the API** in your
      country and for your account type. Eligibility is not universal.

### 2. Meta app

- [ ] Create an app in the Meta developer dashboard, of a type appropriate for
      business/content publishing.
- [ ] Add the products required for Page and Instagram publishing.
- [ ] Record the **App ID** and **App Secret**. The secret enables
      `appsecret_proof`, which this system sends on every call when configured.
- [ ] Add yourself as an app user/tester so you can test before review.

### 3. Permissions and app review

Publishing on behalf of a Page and an Instagram account requires permissions that
Meta gates behind **App Review** for anything beyond your own test accounts.

- [ ] Determine the exact permission set Meta currently requires for:
      Page content publishing, Instagram content publishing, and reading the
      Instagram publishing limit.
- [ ] Check whether **Business Verification** is required for your app.
- [ ] Prepare an App Review submission: screencast, use-case description, and a
      clear statement that content is generated and published by the operator for
      their own accounts.
- [ ] **Budget real time for this.** App Review is not instant and can require
      several rounds. Do not plan a launch date around a first-pass approval.

> Until review is complete you can usually publish to accounts you own using a
> development-mode app. Confirm the current rules before relying on that.

### 4. Tokens

- [ ] Obtain a **User access token** with the required scopes.
- [ ] Exchange it for a **long-lived** token.
- [ ] Exchange that for a **Page access token** for your Page.
- [ ] Verify the token with Meta's token-debug tooling: check scopes, the target
      Page, and the expiry.
- [ ] Record the expiry and set a **calendar reminder well before it** — see the
      rotation runbook in [`operations.md`](operations.md).

### 5. Identifiers

- [ ] Instagram Professional account ID (numeric) → `INSTAGRAM_ACCOUNT_ID`
- [ ] Facebook Page ID (numeric) → `FACEBOOK_PAGE_ID`
- [ ] Current Graph API version → `META_GRAPH_API_VERSION`

None of these are secret; they belong in configuration, not in the secret.

---

## The secret

One Secrets Manager secret holds every credential. The CDK stack creates it with
a placeholder; you replace the value **out of band**. No real token ever appears
in this repository, in `.env.example`, in logs, in Step Functions input/output,
or in DynamoDB.

Required shape (validated by `metaSecretSchema` in
`services/shared/src/secrets.ts`):

```jsonc
{
  "pageAccessToken": "<long-lived Page access token>",   // required
  "instagramAccessToken": "<token>",                      // optional; falls back to pageAccessToken
  "appId": "<app id>",                                    // optional
  "appSecret": "<app secret>"                             // optional but recommended: enables appsecret_proof
}
```

Populate it with the AWS CLI, from a machine that is not this repository's
working tree:

```bash
aws secretsmanager put-secret-value \
  --secret-id mrp-prod-meta \
  --secret-string file:///secure/path/meta-secret.json \
  --region ap-southeast-2

shred -u /secure/path/meta-secret.json   # or equivalent
```

Never paste a token into a shell command that lands in your history, into a CI
log, or into a pull request.

---

## How the tokens are used

- The token is sent as an `Authorization: Bearer` **header**, never as a query
  parameter, so it cannot appear in access logs, proxy logs or error messages.
- When `appSecret` is present, `appsecret_proof` (HMAC-SHA256 of the token) is
  attached to every call.
- Every Graph response passes through `redact()` before it is logged or stored.
- Only the **publisher** IAM role can read the secret. The generation and
  renderer roles cannot.

---

## Publishing flows

Both are implemented in `services/providers/src/publisher/` and driven as explicit
Step Functions states. Verify each phase against current documentation.

### Instagram Reels

1. **Create container** — `POST /{ig-user-id}/media` with `media_type=REELS` and
   `video_url`. Meta fetches the video itself, which is why the pipeline issues a
   short-lived pre-signed S3 URL.
2. **Poll status** — `GET /{container-id}?fields=status_code` until `FINISHED`.
   Bounded by `MAX_CONTAINER_POLL_ATTEMPTS`. Containers expire; `EXPIRED` restarts
   from step 1 rather than retrying a dead ID.
3. **Publish** — `POST /{ig-user-id}/media_publish` with `creation_id`.

The publishing quota (`GET /{ig-user-id}/content_publishing_limit`) is checked
**before** each container is created. An unreadable quota is treated as
*unsupported*, never as *unlimited*.

### Facebook Page Reels

1. **Start** — `POST /{page-id}/video_reels` with `upload_phase=start`, returning
   a video ID.
2. **Upload** — hosted upload against `rupload.facebook.com` with the file URL
   passed as a header.
3. **Poll**, then **finish** — `upload_phase=finish` with
   `video_state=PUBLISHED`.

**Cross-posting is never assumed.** Publishing to the Page does not publish to
Instagram, and vice versa. They are separate transactions with separate state.

---

## Pre-signed URL expiry

Meta pulls the video from a pre-signed S3 URL. `PRESIGNED_URL_TTL_SECONDS`
(default 3600) must cover Meta's fetch **plus** bounded retries, and no longer.
Too short and large uploads fail intermittently; too long and a leaked URL stays
useful. The bucket itself is private and blocks all public access — the signed
URL is the only route in.

---

## Before you flip the switch

- [ ] Run `npm run dry-run` and read `.local/dry-run/meta-payloads.json`. Confirm
      every field matches what Meta currently documents.
- [ ] Confirm the video profile in `renderer/src/profiles.ts` against Meta's
      current Reel specifications.
- [ ] Publish **one** Reel manually with `PUBLISH_MODE=manual_approval` and
      approve it by hand. Look at the result in both apps.
- [ ] Only then consider `auto_publish`, and only with
      `ALLOW_PRODUCTION_PUBLISH=true` and `ENVIRONMENT=prod`.

Remember: a successful publish cannot be rolled back by this system.
