# Tối ưu tải Raspberry Pi — 09/11/2026

Đã cài bền vững trên `facepi.local` và reboot kiểm chứng. Pi khởi động bằng `multi-user.target`, không chạy desktop nền; Wi-Fi, SSH, camera agent và MediaMTX vẫn tự chạy. Webcam mặc định tắt sau mỗi lần cấp điện.

## Thay đổi

- Giải mã MJPEG và chuyển màu trong FFmpeg dùng hai luồng, hạn chế việc tự mở nhiều luồng trên bốn lõi CPU.
- Giữ mã hóa H.264 bằng `h264_v4l2m2m`, kích thước 1280×720, đầu vào 30 FPS, bitrate 6 Mbps và GOP 15. AI tiếp tục ở máy tính.
- Giữ governor `ondemand` hiện có. Không thêm tiến trình theo dõi nhiệt thường trực; công cụ đo chỉ chạy khi được gọi.
- RAM lúc chờ ghi nhận khoảng **396 MiB trước**, **244 MiB sau reboot bản headless**: giảm khoảng 152 MiB. Đây là các ảnh chụp trạng thái hệ thống, có thể thay đổi theo dịch vụ nền.
- Root và boot vẫn chỉ đọc, trạng thái/log trong RAM; lệnh tắt camera và cơ chế mất heartbeat giữ nguyên.

## Số đo video thật qua Wi-Fi

Các khung hình được đọc và mã hóa JPEG trên máy tính như worker backend; không lưu ảnh/video. CPU toàn hệ thống tính trên bốn lõi; CPU FFmpeg dùng thang 100% cho một lõi.

| Chỉ số | Trước, 40 giây | Tối ưu, 40 giây | Tối ưu sau reboot, 120 giây |
| --- | ---: | ---: | ---: |
| Khung hình nhận được | 1.208 | 1.208 | 3.608 |
| FPS thực nhận | 30,20 | 30,19 | 30,07 |
| Kích thước | 1280×720 | 1280×720 | 1280×720 |
| CPU toàn Pi | 15,65% | 15,25% | 16,22% |
| CPU FFmpeg | 54,27% | 53,07% | 56,84% |
| Khoảng cách khung hình p95 | 47 ms | 47 ms | 47 ms |
| Nhiệt độ cao nhất | 40,4°C | 38,9°C | 54,0°C |
| `get_throttled` | `0x0` | `0x0` | `0x0` |

Các lượt bắt đầu ở nhiệt độ khác nhau và có thời lượng khác nhau. Kết quả xác nhận FPS được giữ và không ghi nhận hạ xung trong các lượt đo; không chứng minh một mức giảm nhiệt cố định hoặc thay cho thử nghiệm nhiều giờ. Chênh lệch CPU nhỏ và có dao động giữa các lượt; lợi ích rõ nhất là bỏ desktop nền và giảm RAM, trong khi giữ độ mượt.

Các số liệu thô: [trước](../.qa/pi-thermal-before.json), [trước lặp lại](../.qa/pi-thermal-before-repeat.json), [bản hai luồng](../.qa/pi-thermal-candidate-two.json), [sau reboot hai phút](../.qa/pi-thermal-after.json), [trạng thái triển khai](../.qa/pi-thermal-deployment.json).

## Kiểm chứng và vận hành

- 12 kiểm thử camera agent đạt trên máy phát triển và trên Pi trong lần cài đặt.
- Sau reboot: desktop inactive, hai dịch vụ tự hoạt động, webcam tắt và được giải phóng; mã agent trong lớp chạy và lớp lưu trữ bền vững cùng SHA-256 `ee73fbb02e0324ac1052da24fe07bcbb61ed3e9b90554d4e62340ed5f5d19699`.
- Bài kiểm tra [webcam/AI thật và tự phục hồi](../.qa/pi-live.json) được chạy lại sau tối ưu; bài [tắt Pi từ web](../.qa/pi-poweroff.json) là bước bàn giao cuối.
- Cài lại với chế độ nhẹ: `python Raspberry_pi_4/deploy.py --reboot --headless`. Xem [hướng dẫn](../Raspberry_pi_4/README.md) để bật lại desktop hoặc đo lại.

Tham khảo cấu hình luồng tại [FFmpeg](https://www.ffmpeg.org/ffmpeg.html) và lựa chọn khởi động console/desktop trong [Raspberry Pi Configuration](https://www.raspberrypi.com/documentation/computers/configuration.html).
