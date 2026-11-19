# Task Manager – Vercel + Firebase + Telegram Bot

Ứng dụng web quản lý công việc cá nhân, triển khai frontend và lịch nhắc Telegram trên Vercel; Firebase Authentication, Cloud Firestore (hồ sơ) và Realtime Database (công việc) vẫn được sử dụng.

## 1. Yêu cầu

- Node.js 20+
- Tài khoản Vercel
- Tài khoản Google/Firebase
- Telegram và một bot được tạo bằng `@BotFather`
- Node.js 20+

## 2. Tạo Firebase project

1. Mở https://console.firebase.google.com/ và tạo project.
2. Thêm ứng dụng Web trong Project Overview → Add app → Web.
3. Sao chép `firebaseConfig` và điền vào `js/firebase.js`.
4. Authentication → Sign-in method → bật **Email/Password**.
5. Firestore Database → Create database.
6. Realtime Database → Create Database. URL database phải trùng `databaseURL` trong `js/firebase.js`.
7. Trong Firestore, chọn region gần người dùng (khuyến nghị `asia-southeast1` nếu project mới và còn lựa chọn phù hợp).

## 3. Cấu hình liên kết Telegram Bot

1. Mở Telegram, tìm `@BotFather`.
2. Gửi `/newbot`, làm theo hướng dẫn.
3. Điền username bot (không có `@`) vào `TELEGRAM_BOT_USERNAME` trong `js/config.js`. Username hiện được cấu hình là `auto_taskmanager_bot`.
4. Không cần bot token hoặc chat ID để mở liên kết. Không đưa bot token vào frontend.

## 4. Deploy lên Vercel

1. Đẩy repository lên GitHub rồi import repository vào Vercel.
2. Giữ Root Directory là thư mục gốc của repository; chọn framework preset **Other** nếu Vercel yêu cầu.
3. Thêm các environment variables trong Vercel → Project → Settings → Environment Variables, chọn môi trường **Production**:

   - `TELEGRAM_BOT_TOKEN`: token mới của bot.
   - `TELEGRAM_CHAT_ID`: chat ID cần nhận nhắc việc; mở bot và nhấn **Start** trước.
   - `CRON_SECRET`: chuỗi ngẫu nhiên tối thiểu 16 ký tự chữ/số để bảo vệ API Cron.
   - `FIREBASE_SERVICE_ACCOUNT`: JSON của service account có quyền đọc hồ sơ Firestore và đọc/ghi công việc trong Realtime Database.
   - `FIREBASE_DATABASE_URL`: tùy chọn; mặc định dùng URL Realtime Database của project này.

Không commit service account JSON, bot token hoặc `CRON_SECRET` vào repository. `telegram-config.txt` chỉ là file local đã được Git ignore; Vercel không đọc file local này, nên secrets phải được nhập vào Vercel Environment Variables.

4. Trong Firebase Console, publish rules từ `database.rules.json` vào Realtime Database → Rules để áp dụng index `dueAt`. Có thể publish `firestore.rules` vào Firestore → Rules nếu project chưa có rules tương ứng.
5. Deploy production từ Vercel. Cron chỉ chạy trên production deployment, không chạy trên preview.

Mở URL production của Vercel và đăng ký/đăng nhập bằng email, mật khẩu.

## 5. Mở Telegram Bot

1. Đăng nhập vào Task Manager.
2. Ở Dashboard, nhấn **Mở Telegram Bot**.
3. Trong Telegram, nhấn **Start** để bắt đầu trò chuyện.

Đây là liên kết Telegram trực tiếp, không liên kết Telegram với tài khoản Task Manager và ứng dụng không theo dõi trạng thái Start.

## 6. Quản lý công việc

- Có thể nhân bản công việc; bản sao bắt đầu ở trạng thái chưa hoàn thành.
- Xóa sẽ chuyển công việc vào Thùng rác. Có thể khôi phục hoặc xóa vĩnh viễn tại đó.
- Checklist là các bước trong một công việc; công việc con có trạng thái riêng.
- Tiến độ được tính từ các bước checklist và công việc con đã hoàn thành. Nếu không có mục con, tiến độ là 0% hoặc 100% theo trạng thái công việc.
- Có thể đặt ngày bắt đầu và ngày đến hạn, ghim công việc yêu thích, tìm và lọc công việc.
- Tệp đính kèm hiện được hoãn, chưa có trong phiên bản này.
- Công việc mới được lưu vào Realtime Database tại `users/{uid}/tasks`.
- Ở lần đăng nhập đầu tiên, ứng dụng sao chép task cũ từ Firestore sang Realtime Database; task đã có ở RTDB sẽ không bị ghi đè.

## 7. Nhắc việc tự động

- Khi ứng dụng đang mở, trình duyệt phát âm báo và hiện toast khi công việc đến hạn. Trình duyệt phải cho phép âm thanh; trình duyệt có thể hạn chế âm thanh khi tab đóng hoặc thiết bị ngủ.
- Trên Vercel Hobby, Cron gọi API `/api/telegram-reminders` mỗi ngày theo lịch 00:00 UTC (khoảng 07:00 giờ Việt Nam, có thể lệch tới gần một giờ). API đọc các công việc đến hạn/quá hạn từ Realtime Database và gửi một lần tới `TELEGRAM_CHAT_ID`; việc nhắc có thể trễ tới lần quét tiếp theo. Chạy mỗi phút cần Vercel Pro/Enterprise.
- Công việc hoàn thành hoặc đã xóa không được gửi. Khi đổi hạn, công việc có thể được nhắc lại theo hạn mới.
- Bot chỉ nhắn được sau khi người nhận mở bot và nhấn **Start**. Token bot đã từng bị chia sẻ; hãy thu hồi token cũ qua `@BotFather` và chỉ nhập token mới vào Vercel Environment Variables.
- Cron API kiểm tra `Authorization: Bearer <CRON_SECRET>`; không xóa bước kiểm tra này hoặc để endpoint công khai không có secret.

## 8. Cấu trúc thư mục

```text
task-manager-firebase-telegram/
├── index.html
├── api/
│   └── telegram-reminders.js
├── css/
│   └── style.css
├── js/
│   ├── app.js
│   ├── config.js
│   ├── firebase.js
│   ├── tasks.js
│   ├── telegram.js
│   └── ui.js
├── package.json
├── vercel.json
├── firestore.rules
├── database.rules.json
├── firestore.indexes.json
├── firebase.json
└── README.md
```

## 9. Lưu ý kỹ thuật quan trọng

- Firebase Authentication và Firestore vẫn được dùng cho đăng nhập/hồ sơ; dữ liệu công việc nằm trong Realtime Database.
- `database.rules.json` chỉ cho phép người dùng đã đăng nhập đọc/ghi nhánh `users/{uid}` của chính họ; các task được đánh index theo `dueAt` cho Vercel Cron.
- Không nhúng Telegram Bot Token vào frontend. Liên kết bot chỉ cần username công khai.
- Frontend hiện dùng Firebase Web SDK qua CDN; khi đưa vào môi trường production nên kiểm tra cấu hình domain được phép trong Firebase Authentication.
- Firebase service account chỉ dùng phía server tại Vercel; không đưa private key vào `js/` hoặc HTML.

## 10. Chạy thử local

Có thể chạy frontend local bằng static server. Vercel Cron không chạy trong preview/local; có thể gọi API local thủ công với `CRON_SECRET` để kiểm thử sau khi cấu hình đủ environment variables.

```bash
npm install
```

Realtime Database và Authentication vẫn là dịch vụ Firebase thật, trừ khi chủ động cấu hình Firebase Emulator.

## 11. Hướng phát triển tiếp theo

- Nhắc trước hạn 5/15/30 phút.
- Nhắc lặp hàng ngày, hàng tuần, hàng tháng.
- Lịch tháng/tuần dạng calendar.
- Nhóm công việc và checklist con.
- Chia sẻ công việc cho thành viên khác.
- Báo cáo tiến độ theo tuần/tháng.
- Gửi Telegram kèm nút hoàn thành công việc.
