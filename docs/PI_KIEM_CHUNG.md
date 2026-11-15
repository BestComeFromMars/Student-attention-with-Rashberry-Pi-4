# Kiểm chứng kết nối Raspberry Pi — 09/11/2026

Đã triển khai lên `facepi.local`, kiểm chứng qua SSH, trình duyệt và hai lệnh `npm start` thật. AI chạy trên máy tính; Pi thu webcam USB qua FFmpeg/MediaMTX. Khi bàn giao, Pi đã nhận lệnh tắt từ web và SSH đã offline; frontend/backend cùng các worker cục bộ đều đã đóng, cổng 3000/3001 không còn lắng nghe.

## Kết quả

| Hạng mục | Kết quả |
| --- | --- |
| Frontend | 64 kiểm thử đạt |
| Backend TypeScript | 113 kiểm thử đạt |
| Python AI hiện có | 34 kiểm thử đạt |
| Camera agent Python | 12 kiểm thử đạt trên máy phát triển và trên Pi |
| TypeScript và build hai phía | Đạt |
| Examiner HTTP/trình duyệt | 10 nhóm đạt, 0 lỗi; 2 mục tùy chọn bỏ qua |
| Video Pi thật | Trình duyệt nhận ảnh MJPEG 1280×720 từ RTSP |
| AI thật | Xử lý ảnh webcam qua API thành công; lượt `npm start` trả về 1 track |
| Backend dừng/mở lại | Webcam giải phóng, video và phiên nhận diện tự phục hồi |
| Thiếu heartbeat 10 giây | Webcam dừng, giữ yêu cầu bật để tự phục hồi |
| Tắt/bật camera | Lệnh tắt đặt `desired=false`, xác nhận thiết bị được giải phóng rồi bật lại được |
| Reboot Pi | Hai dịch vụ mới tự chạy; webcam mặc định tắt; mã còn nguyên |
| Tắt Pi thật từ web | Xác nhận → backend → agent trả 202, webcam giải phóng, Pi ngắt SSH |

Tổng cộng 223 kiểm thử đơn vị/hồi quy đạt, cộng các tình huống HTTP/trình duyệt và kiểm chứng thiết bị thật. Mục native AI trong examiner mặc định được bỏ qua; 34 kiểm thử Python và bài webcam/AI thật đã chạy riêng. Gián đoạn kết nối được kiểm tra bằng ngừng heartbeat và dừng backend; không thực hiện cắt điện đột ngột để thử nghiệm.

Lượt webcam kiểm chứng đường truyền và khả năng suy luận, không đánh giá độ chính xác hành vi lớp học hoặc FPS với 40 học sinh. Cấu hình thu hình là 1280×720/30 FPS; bài này không chứng nhận FPS xử lý AI bền vững. Không lưu ảnh/video webcam trong các báo cáo.

## Bản cài và bảo vệ dữ liệu

- Mã trên Pi: `/home/pi/StudentAttention/Raspberry_pi_4`.
- Dịch vụ: `student-attention-camera.service`, `student-attention-media.service`, đều enabled và active sau reboot kiểm chứng. Hai dịch vụ `classlens-*` cũ đã disabled.
- Bản sao lưu trước thay thế: `/home/pi/StudentAttention/backups/20261109-171847/legacy`.
- Agent trong lớp chạy và lớp lưu trữ bền vững có cùng SHA-256 với mã nguồn local: `ee73fbb02e0324ac1052da24fe07bcbb61ed3e9b90554d4e62340ed5f5d19699`.
- Root vật lý `/media/root-ro` và boot `/boot/firmware` xác nhận `ro`; `/media/root-rw` là tmpfs. Swap trống; journald dùng RAM, giới hạn 24 MB. Wi-Fi đang dùng có autoconnect.
- Thông tin kết nối riêng nằm trong `backend/.env`; token/RTSP không đưa vào frontend, dòng lệnh worker hoặc báo cáo.

Overlay chỉ đọc giảm rủi ro hỏng hệ thống tệp khi mất điện; không thay thế nguồn dự phòng hoặc bảo đảm thẻ nhớ không hỏng phần cứng.

## Báo cáo và sử dụng lại

- [Examiner HTML](../.qa/examiner/latest.html), [kết quả JSON](../.qa/examiner/latest.json).
- [Pi và AI thật](../.qa/pi-live.json), [hai lệnh npm start](../.qa/pi-npm-start.json), [tắt Pi thật](../.qa/pi-poweroff.json).
- [Cài đặt, Wi-Fi bền vững và bảo trì](../Raspberry_pi_4/README.md).

Rút/cắm nguồn Pi, mở hai terminal và chạy `npm start` lần lượt trong `backend` và `frontend`. Mở http://localhost:3000, chọn **Raspberry Pi 4**, bấm **Bật camera**, rồi **Bắt đầu nhận diện**. Không cần SSH hoặc chạy lệnh trên Pi mỗi lần sử dụng.

Cập nhật giảm tải Pi: [đo CPU, RAM, nhiệt độ và FPS trước/sau](PI_NHIET_DO.md). Bản cập nhật dùng hai luồng giải mã/chuyển màu và khởi động không desktop; cấu hình video giữ nguyên.
