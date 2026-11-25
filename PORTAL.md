# SmartScan Phone & Web portal — setup guide

The portal lets phones use your office PCs **from anywhere over the internet**:

- **Scan with the phone.** Auto-crop and filters run on the phone, and the scan is saved straight into the PC library as JPG + PDF.
- **Browse the PC library** (people, documents, page previews), **open, download or share PDFs** (for example on WhatsApp), and view pages in full quality.
- **Keep documents offline** on the phone. Changes made on the phone (new scans, added pages, rename, notes, tags, delete) are sent to the PC as soon as there is internet.
- **Several offices and PCs** can use one portal. Each PC user has their own paired phones.

The **PC stays the master copy**: files remain on your PC drive. The portal only passes data between the phones and the PCs, and deletes files once they have been delivered.

## Security in one paragraph
Everything sent through the portal is **end-to-end encrypted** (AES-256-GCM) by the PC or the phone. The key is created on the PC and reaches a phone **only inside the pairing QR code**. It sits in the part of the link after `#`, which browsers never send to a server. Your hosting therefore stores only scrambled data and could not read your documents even if it were hacked.

Two kinds of access control apply on top of the encryption:
- **Office PCs** need the **office setup key** to join the portal.
- **Phones** need a one-time pairing code, valid for 15 minutes. You can remove any phone from the PC at any time. If a phone is lost, *Renew encryption key* cuts off every old phone.

## 1. Requirements
- Shared hosting with **cPanel or hPanel** (Hostinger, Namecheap, Bluehost, GoDaddy…), **PHP 7.4+** and **MySQL/MariaDB**. Nothing else needs installing: no Node, no VPS, no cron jobs.
- **HTTPS** (free SSL / Let's Encrypt in your hosting panel). Phones only allow the camera and encryption on `https://` sites.
- About 20 MB of space, plus temporary space for scans in transit (they are deleted after delivery).

## 2. Install (about 10 minutes, once)
1. Download **`smartscan-portal.zip`**. It is in the *SmartScan-web-portal* artifact of the GitHub Actions build, or you can build it yourself with `npm run build:portal`.
2. In cPanel/hPanel, open **File Manager**. Go to `public_html`, or a sub-domain folder such as `scan.yourdomain.com`. Upload the zip and **Extract** it, which creates the folder `smartscan-portal/`.
   - Optional: rename the folder, or move its contents to the sub-domain's root.
3. In **MySQL Databases**:
   1. Create a database, e.g. `cpuser_smartscan`.
   2. Create a user with a strong password.
   3. **Add the user to the database with ALL PRIVILEGES.**
4. Open `https://yourdomain.com/smartscan-portal/install.php` in a browser and enter:
   - database host (usually `localhost`)
   - database name
   - database user
   - database password
5. The installer shows your **office setup key**, e.g. `5767-E732-82F0-D31B`. **Write it down**: it is shown only once.
6. Delete `install.php` in File Manager.

> The `data/` folder holds the encrypted files in transit. It is protected by `.htaccess`, so it can't be browsed or downloaded directly.

## 3. Connect each office PC
SmartScan desktop → **Phone & Web** →
- **Portal address:** `https://yourdomain.com/smartscan-portal`
- **Office setup key:** the key from step 5
- **Name:** e.g. "Head Office – Ali"

Then click **Connect**. Every SmartScan user on every office PC can connect with the same setup key; each one gets their own separate, encrypted link.

## 4. Connect a phone
1. On the PC: **Phone & Web → Connect a phone**. A QR code appears.
2. On the phone, open the camera and scan the QR code. Tap the link, then tap **Connect this phone**.
3. Optional: in the browser menu, choose **Add to Home screen**, so SmartScan opens like an app (it works on Android and iPhone).

## 5. Everyday use
- **Keep SmartScan running on the office PC.**
  - When a phone is active, the PC checks the portal every 4 seconds; otherwise every 20 seconds.
  - If the PC is off, phone scans wait safely in the phone's **Sent** list and on the portal, and are saved when the PC comes back.
- **Phone tabs:**
  - **Library:** people, then their documents. *Open PDF*, *Share*, *Keep offline*, *Add pages*, rename, notes, tags, delete (the document goes to the PC's Trash).
  - **Scan:** *Take photo* (or pick from the gallery). The page is auto-cropped; tap ✂ to adjust it. Then *Save to office PC* and choose a person, or type a new one.
  - **Sent:** delivery status of each scan or change ("Saved on PC").
  - **More:** default filter, space used, remove offline copies, disconnect.

## Troubleshooting
| Problem | Fix |
|---|---|
| PC says "That address is not a SmartScan portal" | Check the address: it must be the folder that contains `api.php`. |
| "Wrong office setup key" | Use the key shown by `install.php`. If it's lost, delete `config.php` on the hosting and run `install.php` again (then reconnect the PCs). |
| Phone camera button doesn't open the camera | The site must use `https://`. |
| Phone shows "PC is off" | Start SmartScan on the office PC. Check the PC's internet, and that **Phone & Web** shows *Connected*. |
| Large scans fail on upload | Uploads are sent in chunks sized to your hosting's `post_max_size`, so this is rare. Raise the PHP upload limits in the hosting panel if needed. |

## How it works (technical)
- `api.php`: a small JSON API. PCs authenticate with a PC token and phones with a device token (sent in the `X-SS-Token` header); only token hashes are stored.
- Tables: `ss_libraries`, `ss_devices`, `ss_pairings`, `ss_blobs`, `ss_thumbs`, `ss_inbox`, `ss_requests`, `ss_attempts`.
- **PC → portal:** an encrypted catalog (people, documents, page list) and encrypted 320 px thumbnails, re-published when the library changes. When a phone asks for a PDF or a full page, the PC uploads it encrypted; the portal deletes it once the phone has downloaded it (after 7 days at most).
- **Phone → PC:** new scans and changes go into an encrypted outbox. The PC applies them to the library (JPG + PDF on the PC drive), then the portal deletes the uploaded pages.
- Housekeeping runs automatically during normal requests, so no cron job is needed.
