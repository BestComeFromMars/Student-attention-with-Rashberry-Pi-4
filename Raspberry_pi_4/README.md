# Raspberry Pi 4 — camera agent Python

Webcam USB → FFmpeg H.264 → MediaMTX RTSP → OpenCV trên máy tính → backend AI và web. Cấu hình cân bằng giữ 1280×720, thu 25 FPS và phát 15 FPS. Pi không chạy AI và không cần Node.js. Đã kiểm chứng trên Debian 13 arm64, Python 3.13, FFmpeg 7.1.5 và MediaMTX 1.21.3.

Luật quan sát mới (11 dấu hiệu, ngưỡng theo phiên, bbox hiển thị đã lọc và chống báo nói chuyện nhầm) chạy trên backend máy tính, không cần thêm model hoặc sửa camera agent trên Pi. API `detect/pi` và ảnh Pi chụp trên web dùng cùng bộ đánh giá như webcam. Đã kiểm tra hợp đồng qua kiểm thử HTTP với JPEG 1280×720, điều chỉnh ngưỡng, bbox và mất nguồn; đây không phải xác nhận phiên bản agent đang cài trên Pi thật. Chi tiết tại [tài liệu quan sát hiện tại](../docs/prepare/QUAN_SAT_HANH_VI_VA_QUAY_DAU.md).

## Sử dụng

1. Cắm nguồn Pi. NetworkManager tự kết nối Wi-Fi đã lưu; hai dịch vụ tự chạy dù chưa có mạng hoặc backend. Webcam mặc định **tắt**.
2. Chạy `npm start` trong `backend` và `frontend` ở hai terminal trên máy tính.
3. Mở http://localhost:3000, chọn **Raspberry Pi 4**, bấm **Bật camera**, rồi **Bắt đầu nhận diện**.
4. **Tạm dừng nhận diện** giữ video. **Tắt camera** dừng FFmpeg và giải phóng webcam thật; có thể bật lại ngay.
5. **Tắt Raspberry Pi** yêu cầu xác nhận rồi tắt hệ điều hành. Rút/cắm lại nguồn USB-C để bật Pi; phần mềm không cắt vật lý đường cấp điện.

Backend gửi heartbeat mỗi 2 giây. Nếu AI chưa sẵn sàng hoặc mất heartbeat 10 giây, Pi dừng webcam nhưng giữ yêu cầu bật trong `/run`. Khi kết nối phục hồi trong cùng lần khởi động Pi, webcam và phiên nhận diện đang chạy tự tiếp tục. Phiên AI mới xóa mã/tên cũ. Lệnh tắt camera được giữ; mỗi lần Pi khởi động mới phải bấm Bật camera lại.

## Triển khai và cập nhật

Mã nguồn gồm `agent.py`, `systemd/`, `install.sh`, `student-attention-poweroff`, `mediamtx.example.yml`. Agent dùng thư viện chuẩn Python. Dịch vụ chính là `student-attention-camera.service` và `student-attention-media.service`.

Trên Windows, đặt mật khẩu SSH trong biến môi trường `FACEPI_SSH_PASSWORD` của terminal hiện tại, hoặc dùng khóa PuTTY. Trên Linux dùng khóa SSH/agent. Mật khẩu SSH không được ghi vào mã.

```powershell
python Raspberry_pi_4/deploy.py --reboot
```

Nếu mDNS chập chờn, thêm `--ssh-host <IP-Pi>`; vẫn dùng `--host facepi.local` cho địa chỉ backend. Host key được ghim cho facepi hiện tại. Backend phân giải IPv4 của tên `.local`, giữ địa chỉ đang hoạt động khi bỏ lỡ phản hồi mDNS và tìm lại địa chỉ khi kết nối lỗi.

Script dùng MediaMTX arm64 1.21.3 đã có trên Pi, kiểm tra SHA-256 `a1621ba39c0aa58430809df28263865e37a75bb4d2f1c87e642ddf5f3f67b19d`, staging trong `/run`, chạy kiểm thử rồi cài qua `overlayroot-chroot`. Bản cũ được sao lưu dưới `/home/pi/StudentAttention/backups/`; dịch vụ `classlens-*` cũ được vô hiệu hóa. Nếu root bận khi remount, script yêu cầu reboot sạch ngay; chỉ xác nhận thành công sau khi dịch vụ chạy lại và root/boot đều chỉ đọc.

Cấu hình riêng được tạo tại `backend/.env` trên máy tính và `/home/pi/StudentAttention/Raspberry_pi_4/.env`, `mediamtx.local.yml` trên Pi. Không đưa token vào biến `VITE_*`. API agent cổng 8765 yêu cầu Bearer token; RTSP TCP cổng 8554 có tài khoản đọc riêng. MediaMTX chỉ cho publish từ loopback, API quản trị chỉ nghe loopback và `record: false`.

```sh
systemctl status student-attention-camera student-attention-media
journalctl -u student-attention-camera -n 50 --no-pager
```

## Bảo vệ khi mất điện

Root vật lý `/media/root-ro` và `/boot/firmware` ở chế độ `ro`; `/media/root-rw` là tmpfs. Trạng thái camera ở `/run`, nhật ký trong RAM giới hạn 24 MB; không swap trên thẻ. Không ghi ảnh/video xuống đĩa. Cơ chế này giảm rủi ro hỏng hệ thống tệp, không bảo đảm tránh lỗi phần cứng của thẻ hoặc nguồn.

```sh
findmnt -T /media/root-ro
findmnt -T /media/root-rw
findmnt -T /boot/firmware
```

Chép tệp thông thường qua SSH chỉ thay lớp RAM và sẽ mất sau reboot; cập nhật mã bằng script triển khai. Để đổi Wi-Fi bền vững: dùng `sudo raspi-config nonint do_overlayfs 1` rồi reboot vào chế độ bảo trì; cấu hình Wi-Fi bằng `sudo nmtui` và kiểm tra tự kết nối; chạy `sudo raspi-config nonint do_overlayfs 0` rồi reboot để bật lại overlay và boot chỉ đọc. Xác nhận các mount sau bảo trì. Không ghi mật khẩu Wi-Fi vào mã.

Rollback trong chế độ bảo trì: khôi phục mã/cấu hình và unit từ bản sao lưu phù hợp, vô hiệu hóa dịch vụ Student Attention mới và bật lại dịch vụ cũ, rồi bật lại overlay. Bản cũ tự mở webcam khi khởi động.

[Tài liệu overlay của Raspberry Pi](https://www.raspberrypi.com/documentation/computers/configuration.html#enable-or-disable-overlay-file-system).

## Kiểm thử

`npm --prefix Raspberry_pi_4 test` trên máy phát triển hoặc `python3 -m unittest discover -s test -v` trên Pi. Kiểm thử không mở webcam và không gọi poweroff thật.

Kiểm thử thiết bị thật: build backend rồi chạy `node frontend/scripts/pi-live-check.mjs`. Bài này dùng webcam và AI thật, bật/tắt camera, ngắt heartbeat và khởi động lại backend, tự đóng tiến trình; không ghi ảnh/video. Báo cáo `.qa/pi-live.json`.

Chỉ khi đã hoàn tất công việc trên Pi, `node frontend/scripts/pi-poweroff-check.mjs --confirm` kiểm thử nút tắt trên web và **để Pi tắt thật**. Báo cáo `.qa/pi-poweroff.json`. Xem thêm [kết quả kiểm chứng](../docs/PI_KIEM_CHUNG.md).

## Chạy nhẹ và giảm nhiệt

Bản cài dùng cho web/SSH có thể bỏ desktop nền bằng:

```powershell
python Raspberry_pi_4/deploy.py --reboot --headless
```

Tùy chọn này lưu `multi-user.target` vào hệ thống bền vững; Wi-Fi, SSH, camera agent và MediaMTX tiếp tục tự chạy. Khi không truyền `--headless`, script giữ chế độ boot hiện có. Muốn dùng lại desktop, vào chế độ bảo trì như hướng dẫn ở trên, chạy `sudo systemctl set-default graphical.target`, bật lại overlay và reboot.

FFmpeg dùng một luồng giải mã/lọc, giữ mã hóa H.264 phần cứng và 1280×720.
Webcam Jieli thực tế chỉ công bố 25/30 FPS ở chế độ này: mặc định thu 25 FPS,
lọc còn 15 FPS **trước** chuyển màu/mã hóa, bitrate 4 Mbps, GOP 7. Đặt
`CAMERA_INPUT_FPS` và `CAMERA_FPS` trong cấu hình riêng của Pi nếu cần mức
khác đã kiểm chứng với webcam; `CAMERA_FPS` giới hạn 5–30, đầu vào không thấp
hơn đầu ra. Không giảm xuống 360p mặc định vì mất thêm pixel mặt ở xa/tối.
Pi giữ governor `ondemand` hiện có. Camera tắt hoặc backend vắng mặt vẫn
giải phóng tiến trình thu hình. Các bài đo 30 FPS bên dưới là kết quả lịch sử.

Đo trước/sau bằng `backend/.venv/Scripts/python.exe Raspberry_pi_4/scripts/thermal-benchmark.py --label after --seconds 120 --ssh-host <IP-Pi>` trên Windows, hoặc Python có OpenCV trên Linux. Bài đo tạm bật webcam, phát RTSP, đo FPS/nhiệt/CPU rồi tắt webcam; chỉ chạy khi không có phiên quan sát đang dùng. Không lưu ảnh/video. Kết quả JSON ở `.qa/pi-thermal-<label>.json`. [Kết quả tối ưu](../docs/PI_NHIET_DO.md).
