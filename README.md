# Task Manager – Vercel + Firebase + Telegram Bot

Ứng dụng web quản lý công việc cá nhân, triển khai frontend và lịch nhắc Telegram trên Vercel; Firebase Authentication, Cloud Firestore (hồ sơ) và Realtime Database (công việc) vẫn được sử dụng.

## 1. Yêu cầu

- Node.js 20+
- Tài khoản Vercel
- Tài khoản Google/Firebase
- Telegram và một bot được tạo bằng `@BotFather`

## 2. Tạo Firebase project

1. Mở https://console.firebase.google.com/ và tạo project.
2. Thêm ứng dụng Web trong Project Overview → Add app → Web.
3. Sao chép `firebaseConfig` và điền vào `js/firebase.js`.
4. Authentication → Sign-in method → bật **Email/Password** và **Google**; thêm domain production vào danh sách Authorized domains.
5. Firestore Database → Create database.
6. Realtime Database → Create Database. URL database phải trùng `databaseURL` trong `js/firebase.js`.
7. Storage → Get started để bật Firebase Storage cho project.
8. Trong Firestore, chọn region gần người dùng (khuyến nghị `asia-southeast1` nếu project mới và còn lựa chọn phù hợp).

## 3. Cấu hình liên kết Telegram Bot

1. Mở Telegram, tìm `@BotFather`.
2. Gửi `/newbot`, làm theo hướng dẫn.
3. Điền username bot (không có `@`) vào `TELEGRAM_BOT_USERNAME` trong `js/config.js`. Username hiện được cấu hình là `auto_taskmanager_bot`.
4. Không đưa bot token vào frontend; việc liên kết từng tài khoản được thực hiện bằng mã dùng một lần.

## 4. Deploy lên Vercel

1. Đẩy repository lên GitHub rồi import repository vào Vercel.
2. Giữ Root Directory là thư mục gốc của repository; chọn framework preset **Other** nếu Vercel yêu cầu.
3. Thêm các environment variables trong Vercel → Project → Settings → Environment Variables, chọn môi trường **Production**:

   - `TELEGRAM_BOT_TOKEN`: token mới của bot.
   - `CRON_SECRET`: chuỗi ngẫu nhiên tối thiểu 16 ký tự chữ/số để bảo vệ API; dùng cùng giá trị khi cấu hình scheduler ngoài.
   - `TELEGRAM_WEBHOOK_SECRET`: chuỗi bí mật riêng để xác thực webhook do Telegram gọi.
   - `ADMIN_EMAILS`: danh sách email khởi tạo Admin, phân tách bằng dấu phẩy. Chỉ tài khoản có email đã xác minh được cấp role Admin; các tài khoản khác mặc định là User.
   - `FIREBASE_SERVICE_ACCOUNT`: JSON của service account server có quyền Firebase Admin Auth, đọc Firestore users và đọc/ghi Realtime Database (công việc, thành viên, bình luận, tiến độ, cài đặt, liên kết Telegram và lịch sử thông báo).
   - `FIREBASE_DATABASE_URL`: tùy chọn; mặc định dùng URL Realtime Database của project này.

Không commit service account JSON, bot token, `CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET` hoặc danh sách email Admin vào repository. `telegram-config.txt` chỉ là file local đã được Git ignore; Vercel không đọc file local này, nên biến môi trường phải được nhập vào Vercel Environment Variables.

4. Trong Firebase Console, publish rules từ `database.rules.json` vào Realtime Database → Rules để áp dụng quyền và index cho công việc, thành viên, bình luận và tiến độ; publish `storage.rules` vào Storage → Rules để giới hạn tệp theo tài khoản, loại và dung lượng. Có thể publish `firestore.rules` vào Firestore → Rules nếu project chưa có rules tương ứng. Các Firebase rules không được deploy cùng Vercel.
5. Deploy production từ Vercel.
6. Sau khi deploy, cấu hình Telegram webhook một lần bằng `setWebhook` (thay domain bằng domain Vercel production; dùng secret đã đặt trong Vercel):

   ```bash
   curl --request POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     --data-urlencode "url=https://<production-domain>/api/telegram-webhook" \
     --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
     --data-urlencode 'allowed_updates=["message","callback_query"]'
   ```

Mở URL production của Vercel và đăng ký/đăng nhập bằng Google hoặc email, mật khẩu.

## 5. Mở Telegram Bot

1. Đăng nhập vào Task Manager.
2. Mở **Cài đặt → Liên kết Telegram → Tạo liên kết**.
3. Mở liên kết vừa tạo và nhấn **Start** trong bot trước khi nhận thông báo.

Mỗi tài khoản Task Manager liên kết với một chat Telegram riêng; dùng `/unlink` trong bot hoặc nút **Ngắt liên kết** để thu hồi.

Với email/mật khẩu, tài khoản mới nhận email xác minh. Google Sign-In cần bật trong Firebase Authentication; tài khoản allowlist Admin phải xác minh email trước khi được cấp role.

## 6. Quản lý công việc

- Có thể nhân bản công việc; bản sao bắt đầu ở trạng thái chưa hoàn thành.
- Xóa sẽ chuyển công việc vào Thùng rác. Có thể khôi phục hoặc xóa vĩnh viễn tại đó.
- Có thể tạo và lọc theo nhóm tùy chỉnh riêng với danh mục; mỗi công việc thuộc tối đa một nhóm.
- Xóa nhóm sẽ chuyển các công việc đang hoạt động trong nhóm vào Thùng rác và bỏ liên kết nhóm; các công việc này vẫn có thể khôi phục.
- Checklist và công việc con có thể được thêm vào công việc; trạng thái công việc cha đồng bộ với các mục con, tiến độ tính theo checklist và công việc con.
- Lịch hỗ trợ chế độ ngày, tuần (bắt đầu từ thứ Hai) và tháng; có thể lọc trạng thái/ưu tiên và kéo thả công việc để dời ngày, giữ nguyên giờ và thời lượng.
- Công việc có thể có ngày bắt đầu và ngày đến hạn; lịch đánh dấu ngày nghỉ và hiển thị danh sách công việc quá hạn.
- Có thể tùy chỉnh giao diện sáng/tối, màu nhấn, giờ làm, ngày nghỉ hằng tuần/ngày nghỉ riêng và mốc nhắc mặc định. Nhật ký giữ 100 hoạt động gần nhất; Thùng rác hỗ trợ khôi phục công việc.
- Có thể ghim công việc yêu thích, tìm và lọc công việc.
- Có thể cập nhật tên hiển thị trong **Cài đặt → Hồ sơ cá nhân**. Email/mật khẩu và Google dùng chung Firebase Authentication.
- Email trong `ADMIN_EMAILS` được bootstrap role Admin sau khi xác minh; Admin có thể tìm tài khoản đã đăng ký và đổi role Admin/User. Người dùng không thể tự ghi role vào hồ sơ để nâng quyền.
- Chủ công việc có thể giao công việc cho email đã đăng ký. Thành viên được giao xem công việc, cập nhật tiến độ cá nhân và bình luận; chỉ chủ sở hữu quản lý nội dung chính và thành viên. Admin có thể quản lý role và thành viên.
- Thành viên và tiến độ được lưu riêng theo từng công việc; bình luận hiển thị danh tính và thời điểm gửi. Cập nhật vai trò có hiệu lực sau khi tài khoản đăng nhập lại.
- Dashboard hiển thị tổng số, hoàn thành, đang thực hiện (có checklist/đầu việc đã hoàn thành), đến hạn hôm nay và quá hạn; biểu đồ tuần/tháng so sánh việc tạo mới với việc hoàn thành và thống kê tỷ lệ hoàn thành theo danh mục.
- Báo cáo cho phép chọn ngày bắt đầu/kết thúc, gồm số việc tạo trong kỳ, hoàn thành trong kỳ, đến hạn trong kỳ, quá hạn tại cuối kỳ và tỷ lệ hoàn thành đến cuối kỳ trên nhóm việc đến hạn trong kỳ. Danh sách báo cáo bao gồm việc được tạo, đến hạn, hoàn thành hoặc còn quá hạn trong khoảng đã chọn. Có thể tải workbook Excel XML nhiều trang để mở bằng Excel, hoặc in báo cáo ngang và chọn “Lưu thành PDF”.
- Công việc hỗ trợ nhãn, màu riêng, ghi chú riêng, tệp đính kèm và liên kết HTTP(S).
- Mỗi công việc hỗ trợ tối đa 10 tệp/liên kết; mỗi tệp tối đa 10 MB. Hỗ trợ ảnh JPEG/PNG/GIF/WebP, PDF, TXT và tài liệu Word/Excel/PowerPoint. Tệp được lưu trong Firebase Storage theo UID; xóa vĩnh viễn chỉ hoàn tất sau khi xóa được mọi tệp. Nếu Storage từ chối xóa, công việc vẫn nằm trong Thùng rác để có thể thử lại.
- Nhân bản sao chép nhãn, màu, ghi chú, checklist và liên kết; tệp đã tải lên không được sao chép và cần đính kèm lại.
- Có thể lặp công việc hằng ngày, tuần, tháng hoặc năm. Khi hoàn thành một kỳ, ứng dụng giữ kỳ đã xong trong lịch sử và tạo một công việc mới cho kỳ tiếp theo; ngày 29–31 được giới hạn theo số ngày của tháng/năm đích.
- Công việc mới được lưu vào Realtime Database tại `users/{uid}/tasks`.
- Ở lần đăng nhập đầu tiên, ứng dụng sao chép task cũ từ Firestore sang Realtime Database; task đã có ở RTDB sẽ không bị ghi đè.

## 7. Nhắc việc tự động

- Khi ứng dụng đang mở, trình duyệt phát âm báo và hiện toast khi công việc đến hạn. Trình duyệt phải cho phép âm thanh; trình duyệt có thể hạn chế âm thanh khi tab đóng hoặc thiết bị ngủ.
- Trên Vercel Hobby, hãy dùng scheduler bên ngoài gọi `GET https://<production-domain>/api/telegram-reminders` mỗi phút với header `Authorization: Bearer <CRON_SECRET>`. Vercel Cron cấu hình sẵn đã được bỏ để tránh chạy trùng; scheduler phải hỗ trợ chu kỳ một phút.
- Mỗi công việc có thể dùng mốc nhắc trước hạn 5/15/30/60 phút (mặc định lấy từ Cài đặt hệ thống); API vẫn gửi thông báo riêng khi đến hạn và cảnh báo quá hạn.
- Nút ngay dưới tin nhắn Telegram cho phép hoàn thành, hoãn 1 giờ hoặc dời đến đầu giờ làm của ngày làm việc kế tiếp (tôn trọng ngày nghỉ hằng tuần và ngày nghỉ riêng). Hoàn thành việc lặp tạo kỳ tiếp theo như trong ứng dụng.
- Báo cáo đầu ngày và cuối ngày được gửi theo giờ bắt đầu/kết thúc làm việc đã lưu trong Cài đặt (múi giờ `Asia/Ho_Chi_Minh`); mỗi loại báo cáo chỉ gửi một lần mỗi ngày.
- Cài đặt hiển thị tối đa 100 lần gửi gần nhất, gồm nhắc trước hạn, đến hạn/quá hạn, báo cáo và trạng thái gửi lỗi.
- Công việc hoàn thành hoặc đã xóa không được gửi. Khi đổi hạn hoặc mốc nhắc, trạng thái gửi tương ứng được đặt lại.
- Bot chỉ nhắn được sau khi người nhận mở bot và nhấn **Start**. Token bot đã từng bị chia sẻ; hãy thu hồi token cũ qua `@BotFather` và chỉ nhập token mới vào Vercel Environment Variables.
- Cron API kiểm tra `Authorization: Bearer <CRON_SECRET>` và webhook kiểm tra secret token do Telegram gửi; không xóa các bước này hoặc để endpoint công khai không có secret.

## 8. Cấu trúc thư mục

```text
task-manager-firebase-telegram/
├── index.html
├── api/
│   ├── firebase-admin.js
│   ├── reminder-utils.js
│   ├── telegram-link.js
│   ├── telegram-logs.js
│   ├── telegram-reminders.js
│   └── telegram-webhook.js
├── css/
│   └── style.css
├── js/
│   ├── app.js
│   ├── calendar-utils.mjs
│   ├── config.js
│   ├── firebase.js
│   ├── recurrence-utils.mjs
│   ├── tasks.js
│   ├── telegram.js
│   └── ui.js
├── package.json
├── firestore.rules
├── database.rules.json
├── storage.rules
├── firestore.indexes.json
├── firebase.json
├── test/
│   ├── calendar-utils.test.mjs
│   ├── recurrence-utils.test.mjs
│   ├── reminder-utils.test.js
│   └── telegram-api.test.js
└── README.md
```

## 9. Lưu ý kỹ thuật quan trọng

- Firebase Authentication và Firestore vẫn được dùng cho đăng nhập/hồ sơ; dữ liệu công việc nằm trong Realtime Database.
- `database.rules.json` chỉ cho phép người dùng đã đăng nhập đọc/ghi nhánh `users/{uid}` của chính họ; task được đánh index theo `dueAt`, nhật ký hoạt động và thông báo theo `createdAt`. Link codes chỉ được API Admin truy cập và có thời hạn 10 phút.
- Không nhúng Telegram Bot Token vào frontend. Liên kết bot chỉ cần username công khai.
- Frontend hiện dùng Firebase Web SDK qua CDN; khi đưa vào môi trường production nên kiểm tra cấu hình domain được phép trong Firebase Authentication.
- Firebase service account chỉ dùng phía server tại Vercel; không đưa private key vào `js/` hoặc HTML.

## 10. Chạy thử local

Chạy `npm test` để kiểm tra lịch ngày/tuần/tháng và logic nhắc. Có thể chạy frontend local bằng static server; API Telegram chỉ gửi khi được gọi với đầy đủ environment variables.

```bash
npm install
```

Realtime Database và Authentication vẫn là dịch vụ Firebase thật, trừ khi chủ động cấu hình Firebase Emulator.

## 11. Hướng phát triển tiếp theo

- Chia sẻ công việc cho thành viên khác.
- Báo cáo tiến độ theo tuần/tháng.
