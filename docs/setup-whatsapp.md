# Set up WhatsApp (Cloud API)

This server talks to the official WhatsApp Business Platform (Cloud API). You need a Meta developer account, a Meta app and a WhatsApp Business Account (WABA) with a phone number.

Meta's screens change often. Names below follow the current Meta for Developers dashboard; if something moved, search the official docs for "WhatsApp Cloud API get started".

## 1. Create the app and add WhatsApp

1. Go to developers.facebook.com, open **My Apps** and create an app of type **Business**.
2. Add the **WhatsApp** product. Link or create a Meta business portfolio and a WhatsApp Business Account when asked.
3. Open **WhatsApp > API Setup**. It shows a test phone number, its **Phone number ID** and your **WhatsApp Business Account ID**.

| Value | Environment variable |
| --- | --- |
| Phone number ID | `WHATSAPP_PHONE_NUMBER_ID` |
| WhatsApp Business Account ID | `WHATSAPP_BUSINESS_ACCOUNT_ID` (needed only for `list_whatsapp_templates`) |
| Access token | `WHATSAPP_ACCESS_TOKEN` |

The test number can only message up to five recipient numbers that you add and verify in API Setup. To use your own number, add it under **API Setup > Add phone number** and complete verification.

## 2. Create a permanent access token

The temporary token on the API Setup page expires after about a day. For a server use a system user token:

1. In **Business Settings > Users > System users**, create a system user (admin role is simplest).
2. **Add assets**: your app (full control) and your WhatsApp Business Account (full control).
3. **Generate token** for your app with these permissions:
   - `whatsapp_business_messaging` (send and receive messages)
   - `whatsapp_business_management` (list templates, manage the account)
4. Store the token as `WHATSAPP_ACCESS_TOKEN`. Treat it like a password.

## 3. Receive incoming messages (webhook)

Replies from customers reach this server through a webhook.

1. Pick a secret string and set it as `META_VERIFY_TOKEN`.
2. Copy the **App secret** from **App settings > Basic** and set it as `META_APP_SECRET`. It is used to verify the `X-Hub-Signature-256` header of every delivery.
3. Start the server with the receiver enabled: `messaging-mcp --webhook-port 8787` (see the README for always-on setups).
4. Make `http://127.0.0.1:8787/webhooks/meta` reachable over public HTTPS (a reverse proxy or a tunnel such as cloudflared or ngrok).
5. In **WhatsApp > Configuration** set **Callback URL** to `https://your.host/webhooks/meta` and **Verify token** to your `META_VERIFY_TOKEN`, then **Verify and save**.
6. Under **Webhook fields**, subscribe to **messages**.
7. Make sure your app is subscribed to the WhatsApp Business Account (the `subscribed_apps` edge of the WABA); the dashboard does this for you when you save the webhook for your own account.

## 4. Test

Message your WhatsApp number from a phone. Within a few seconds `list_conversations` should show the conversation. Then ask the assistant to reply: inside the 24 hour window `send_message` sends a normal text, afterwards it refuses and suggests a template.

## Templates

To message a customer after the 24 hour window closes, WhatsApp only accepts an approved template. Create templates in **WhatsApp Manager > Message templates** and wait for approval. `list_whatsapp_templates` lists them with their parameter counts, `send_whatsapp_template` sends one (body text parameters only in v0.1).

Marketing templates need the customer's opt-in; utility templates must relate to an existing transaction or conversation. This server does not check opt-in, that is yours to guarantee.

## Permissions and App Review

- While your app is in **Development** mode, only people with a role on the app (and recipients you verified for the test number) can use it. That is enough to build and test.
- Sending to the public from a number of your own business generally works with your own business assets once the business is verified and the number is registered. Messaging limits (how many unique customers you may open a conversation with per day outside the window) start low and grow with quality and volume.
- If you are a tech provider serving other businesses, you need **Advanced Access** through **App Review** for `whatsapp_business_messaging` and `whatsapp_business_management`.

Meta's requirements change; check the current WhatsApp Business Platform documentation for App Review, business verification and messaging limits before going live.
