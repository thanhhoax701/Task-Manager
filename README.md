# Task Manager – Firebase + Telegram

Ứng dụng web quản lý công việc cá nhân, sử dụng Firebase Authentication, Cloud Firestore, Cloud Functions và Telegram Bot.

## 1. Yêu cầu

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`
- Tài khoản Google/Firebase
- Telegram và một bot được tạo bằng `@BotFather`
- Firebase project dùng gói **Blaze** để triển khai Cloud Functions và Cloud Scheduler (có thể phát sinh phí theo mức sử dụng).

## 2. Tạo Firebase project

1. Mở https://console.firebase.google.com/ và tạo project.
2. Thêm ứng dụng Web trong Project Overview → Add app → Web.
3. Sao chép `firebaseConfig` và điền vào `js/firebase.js`.
4. Authentication → Sign-in method → bật **Email/Password**.
5. Firestore Database → Create database.
6. Trong Firestore, chọn region gần người dùng (khuyến nghị `asia-southeast1` nếu project mới và còn lựa chọn phù hợp).
7. Thay `YOUR_PROJECT_ID` trong `.firebaserc.example`, sau đó đổi tên file thành `.firebaserc`.

## 3. Tạo Telegram Bot

1. Mở Telegram, tìm `@BotFather`.
2. Gửi `/newbot`, làm theo hướng dẫn.
3. Lưu Bot Token ở nơi an toàn. Không đưa token vào frontend hoặc Git.
4. Chọn username bot (không có @), ví dụ `my_task_reminder_bot`.
5. Thay `YOUR_TELEGRAM_BOT_USERNAME` trong:
   - `js/config.js`
   - `functions/src/index.ts` (hằng `BOT_USERNAME`).

## 4. Cài đặt và deploy backend

Tại thư mục dự án:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
```

Chọn đúng Firebase project. Sau đó:

```bash
cd functions
npm install
cd ..
```

Chuyển Firebase project sang gói Blaze nếu Firebase yêu cầu để bật Functions/Scheduler. Thiết lập secrets:

```bash
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
firebase functions:secrets:set TELEGRAM_WEBHOOK_SECRET
```

- `TELEGRAM_BOT_TOKEN`: token lấy từ BotFather.
- `TELEGRAM_WEBHOOK_SECRET`: chuỗi bí mật tự tạo dài, ví dụ một chuỗi ngẫu nhiên 32+ ký tự. Không dùng ví dụ công khai.

Deploy rules, indexes, hosting và functions:

```bash
firebase deploy
```

Sau deploy, lấy URL của function `telegramWebhook` trong Firebase Console → Functions. URL có dạng:

`https://asia-southeast1-YOUR_PROJECT_ID.cloudfunctions.net/telegramWebhook`

## 5. Cấu hình Telegram webhook

Thay các giá trị rồi chạy lệnh sau trong PowerShell (không commit token/secret vào source):

```powershell
$BOT_TOKEN = "TOKEN_CUA_BOT"
$WEBHOOK_SECRET = "CHUOI_BI_MAT_CUA_BAN"
$WEBHOOK_URL = "URL_FUNCTION_telegramWebhook"

Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" `
  -ContentType "application/json" `
  -Body (@{
    url = $WEBHOOK_URL
    secret_token = $WEBHOOK_SECRET
    allowed_updates = @("message")
  } | ConvertTo-Json)
```

Kết quả mong đợi có `"ok": true`. Secret gửi vào header của Telegram phải trùng chính xác secret đã lưu trong Firebase Secret Manager.

## 6. Deploy Hosting

Nếu chưa deploy Hosting ở bước trên:

```bash
firebase deploy --only hosting
```

Mở URL Hosting được Firebase cung cấp. Đăng ký tài khoản bằng email/mật khẩu.

## 7. Liên kết Telegram

1. Đăng nhập vào Task Manager.
2. Chọn **Liên kết Telegram** ở Dashboard.
3. Nhấn **Mở Telegram Bot**.
4. Nhấn **Start** trong Telegram.
5. Bot phản hồi liên kết thành công.
6. Quay lại ứng dụng. Trạng thái Telegram sẽ chuyển thành đã liên kết.

Mã liên kết có hiệu lực 10 phút và chỉ sử dụng một lần.

## 8. Tạo nhắc việc

1. Nhấn **Tạo công việc**.
2. Nhập tên, mô tả, danh mục, ưu tiên.
3. Chọn ngày và giờ đến hạn.
4. Tích **Nhắc tôi qua Telegram vào thời điểm đến hạn**.
5. Lưu công việc.

Cloud Scheduler kiểm tra mỗi phút và gửi tin nhắn Telegram khi tới thời điểm nhắc.

## 9. Cấu trúc thư mục

```text
task-manager-firebase-telegram/
├── index.html
├── css/
│   └── style.css
├── js/
│   ├── app.js
│   ├── config.js
│   ├── firebase.js
│   ├── functions-client.js
│   ├── tasks.js
│   ├── telegram.js
│   └── ui.js
├── functions/
│   ├── src/index.ts
│   ├── package.json
│   └── tsconfig.json
├── firestore.rules
├── firestore.indexes.json
├── firebase.json
└── README.md
```

## 10. Lưu ý kỹ thuật quan trọng

- **Không nhúng Telegram Bot Token trong frontend.** Token chỉ được lưu trong Firebase Secret Manager.
- Firestore Rules chặn client đọc/ghi `users/{uid}/private/**` và `telegramLinkCodes`; Cloud Functions dùng Admin SDK để thao tác backend.
- Scheduler đang gửi nhắc **một lần cho mỗi lần đặt reminder**. Đây là phiên bản nhắc một lần, chưa có nhắc lặp.
- Nếu thay đổi ngày/giờ nhắc khi sửa công việc, app đặt lại `reminderSentAt` để lần nhắc mới được xử lý.
- Nếu công việc đến hạn khi chưa liên kết Telegram, hệ thống đánh dấu skipped để không gửi lặp. Hãy liên kết Telegram trước khi tạo nhắc.
- Không chia sẻ Bot Token, Firebase service account key hoặc webhook secret.
- Đặt quy tắc chi phí/budget alert trong Google Cloud Billing. Cloud Scheduler và Functions có thể phát sinh chi phí.
- Frontend hiện dùng Firebase Web SDK qua CDN; khi đưa vào môi trường production nên kiểm tra cấu hình domain được phép trong Firebase Authentication.

## 11. Chạy thử local

Có thể dùng Firebase Hosting emulator:

```bash
firebase emulators:start --only hosting,auth,firestore
```

Lưu ý: phần gửi Telegram và Scheduler cần backend đã deploy để kiểm thử end-to-end; không nên coi emulator Hosting đơn lẻ là đã kiểm thử webhook.

## 12. Hướng phát triển tiếp theo

- Nhắc trước hạn 5/15/30 phút.
- Nhắc lặp hàng ngày, hàng tuần, hàng tháng.
- Lịch tháng/tuần dạng calendar.
- Nhóm công việc và checklist con.
- Chia sẻ công việc cho thành viên khác.
- Báo cáo tiến độ theo tuần/tháng.
- Gửi Telegram kèm nút hoàn thành công việc.
