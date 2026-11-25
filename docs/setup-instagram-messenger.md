# Set up Messenger and Instagram

Both channels use Meta's Messenger Platform style Send API and the same webhook receiver as WhatsApp (`/webhooks/meta`). You need a Meta developer app. Meta's dashboard changes often; if a screen moved, search the official docs for "Messenger Platform" or "Instagram messaging API".

Common to both:

- `META_APP_SECRET`: **App settings > Basic > App secret**. Used to verify the signature of every webhook delivery.
- `META_VERIFY_TOKEN`: any secret string you choose; you enter the same string in the webhook configuration.
- Start the server with `--webhook-port 8787` and expose `https://your.host/webhooks/meta` (reverse proxy or tunnel).

## Messenger

Requirements: a Facebook Page, and an app with the **Messenger** product.

1. In the app dashboard add the **Messenger** product (Messenger API settings).
2. **Generate access tokens** for your Page. Use a long-lived Page access token. Needed permissions:
   - `pages_messaging`
   - `pages_manage_metadata` (to subscribe the Page to webhooks)
   - `pages_show_list`
3. Set:
   - `MESSENGER_PAGE_ACCESS_TOKEN`: the Page access token
   - `MESSENGER_PAGE_ID`: the Page id (shown next to the Page in the token generator, and in the Page's About section)
4. Configure the webhook: Callback URL `https://your.host/webhooks/meta`, Verify token = `META_VERIFY_TOKEN`. Subscribe the **Page** object to `messages`, `messaging_postbacks` and `message_echoes` (echoes let the server record replies sent from the Page inbox).
5. Subscribe your Page to the app (the "Add subscriptions" step next to the token generator).

Reply rules (enforced before sending): a reply is allowed within 24 hours of the customer's last message (up to 7 days when the conversation started from a click-to-Messenger ad). Outside the window only a message tag such as `HUMAN_AGENT` (a person replying manually, up to 7 days) is possible; the tag is refused for automated senders. Several older tags were retired in 2026.

## Instagram

Requirements: an Instagram **professional** account (Business or Creator). Messaging must be allowed for connected tools in the Instagram app (Settings > Messages and story replies > Connected tools).

The default path is the **Instagram API with Instagram Login**:

1. Add the **Instagram** product to your app and open **API setup with Instagram login**.
2. Add the Instagram professional account and generate a token. Permissions:
   - `instagram_business_basic`
   - `instagram_business_manage_messages`
3. Set:
   - `INSTAGRAM_ACCESS_TOKEN`: the Instagram user access token
   - `INSTAGRAM_ACCOUNT_ID`: the Instagram professional account id shown in the setup page
4. Configure the webhook for the **Instagram** object (same callback URL and verify token) and subscribe to `messages`. Subscribe the Instagram account to the app's webhooks in the same screen.

The server posts to `https://graph.instagram.com/<version>/<IG_ID>/messages`. If you use Facebook Login based tokens, set `INSTAGRAM_API_HOST=https://graph.facebook.com` and `INSTAGRAM_ACCOUNT_ID` to the id that your token's messages endpoint expects. That variant is not tested by the author; see the README limits.

Reply rules: a reply to a customer's message is allowed within 24 hours; the human agent tag extends this to 7 days for a person replying manually.

## App Review

- In **Development** mode only users with a role on the app (admin, developer, tester) and accounts they own can use the permissions. That is enough to run this server against your own Page and Instagram account.
- To message the public through an app you do not own the accounts of, the permissions above need **Advanced Access**, granted through **App Review** (screencast, use case description, privacy policy URL) and usually Business Verification.
- Review requirements change. Read the current Messenger Platform and Instagram messaging documentation before submitting.

## Test

Message your Page or Instagram account from another account. `list_conversations` should show it within seconds. Replying with `send_message` works inside the window; after that it refuses and tells you why.
