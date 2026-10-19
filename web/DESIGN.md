# Invito

Invitation builder for Telegram (mini app + bot) and the web. Pick an event, a template, add your words, route and photos, and share a link with a rich preview.

## Files
- `Invito.dc.html` — the app: home, features tour, event picker, template gallery, 9-step builder, tap-to-edit editor, share screen, guest page, guest manager
- `InviteCover.dc.html` — template cover thumbnail (used in galleries, drafts, previews)
- `invito-data.js` — i18n (RU / EN / UZ Latin / UZ Cyrillic), 12 events, 14 styles × palettes, 60 templates, sample guests
- `invito-engine.js` — generative music, OG/story image renderer, scratch-card
- `support.js` — runtime for `.dc.html` files

## Run
Serve the folder with any static server and open `Invito.dc.html`:

```
npx serve .
```

Opening the file directly from disk will not work (ES module imports need http).
