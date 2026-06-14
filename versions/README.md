# Folder snapshot versioning

This project stores editable blog content in `versions/current/`.

- `versions/current/posts/`: the live markdown posts that Astro builds from
- `versions/current/assets/`: versioned editable assets such as `home-bg.jpg`
- `versions/snapshots/<timestamp>/`: automatic point-in-time snapshots created before write operations

Useful commands:

- `npm run snapshot:create -- "reason"`
- `npm run snapshot:list`
- `npm run snapshot:restore -- <snapshot-id>`
- `npm run sync:assets`

The `public/assets/home-bg.jpg` file is treated as a published copy and is synced from `versions/current/assets/home-bg.jpg`.
