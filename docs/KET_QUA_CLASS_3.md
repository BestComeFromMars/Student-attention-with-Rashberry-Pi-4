# Kết quả thử nghiệm trên video class_3.mp4

Video đánh giá: `backend/tests/test_results/class_3.mp4`.

Số liệu được tổng hợp từ lần chạy đã ghi nhận tại `.qa/adaptive_tracking_20261115/live/`. File video trong lần chạy này và file kết quả hiện tại có cùng SHA-256, bảo đảm số liệu thuộc đúng bản video đang báo cáo. Không chạy lại suy luận trong lần tổng hợp này.

## 1. Hiệu năng hoạt động

| Tiêu chí | Kết quả |
| --- | ---: |
| Độ phân giải video kết quả | 1906 × 1080 pixel |
| Thời lượng video kết quả | 17,77 giây |
| Số khung hình video kết quả | 533 |
| Tốc độ video kết quả | 30 FPS |
| Tốc độ hiển thị ảnh kèm khung đánh dấu khi chạy | 29,14 FPS |
| Số khung ảnh kèm tọa độ được trình bày trong lần chạy | 520 |
| Số lượt phản hồi AI trong thời gian phát | 18 |
| Tốc độ phản hồi AI trung bình theo thời gian chạy | Khoảng 1,01 lượt/giây |
| Thời gian phản hồi AI trung bình mỗi yêu cầu | 865 ms |
| Thời gian xử lý hình học P95 | 25,45 ms |
| Thời gian trình bày P95 | 80,20 ms |
| Đồng bộ ảnh và tọa độ khung đánh dấu | Cùng frame ID |
| Lỗi giao diện, API và bám ảnh được ghi nhận | 0 |

P95 là mốc mà 95% mẫu đo không vượt quá. FPS hiển thị phản ánh độ liên tục của ảnh và khung đánh dấu; tốc độ phản hồi AI phản ánh nhịp cập nhật phân tích hành vi. Các số đo trên thuộc lần chạy video thử nghiệm.

## 2. Kết quả phát hiện học sinh cần chú ý

Đếm trực tiếp học sinh xuất hiện trong hình cho thấy **19 học sinh**, gồm 7 ở cụm bàn bên trái, 7 ở cụm giữa và 5 ở cụm bên phải. Đây là số người đếm theo hình, không lấy tổng mã theo dõi phát sinh làm tổng số học sinh.

Trong thời gian phát video, hệ thống gắn nhãn **Cần chú ý cho 4 học sinh**. Đây là số dự đoán của hệ thống, cần đối chiếu với các trường hợp thực tế trong video để tính tỷ lệ phát hiện đúng.

| Mã hiển thị | Dấu hiệu hệ thống ghi nhận | Thời điểm phản hồi cảnh báo đầu tiên trên video |
| --- | --- | ---: |
| T | Có dấu hiệu gục đầu/thân trên | 5,36 giây |
| S | Quay lệch hướng lâu | 5,36 giây |
| L | Quay lệch hướng lâu | 7,39 giây |
| P | Quay lệch hướng lâu | 13,17 giây |

Mỗi học sinh chỉ được tính một lần trong tổng 4 người, dù xuất hiện trong nhiều phản hồi cảnh báo. Thời điểm trong bảng là lúc phản hồi cảnh báo hoàn tất theo thời gian phát video, không phải thời điểm hành vi bắt đầu.

### Tỷ lệ phát hiện qua đối chiếu trực quan

**Tỷ lệ phát hiện học sinh cần chú ý (recall) = số học sinh thực sự cần chú ý được hệ thống phát hiện đúng / tổng số học sinh thực sự cần chú ý × 100%.**

Đã rà chuỗi ảnh nguồn chưa chèn bbox, lấy mỗi 0,5 giây từ giây 0 đến 17,5, tổng cộng 36 mẫu cho mỗi học sinh. Dùng mã hiển thị để tham chiếu vị trí, nhưng xác định hành vi từ ảnh nguồn. Một học sinh có ít nhất một dấu hiệu phù hợp được tính một lần trong toàn video.

Tiêu chí đối chiếu trực quan: quay đầu/thân rõ sang bên kéo dài khoảng 2 giây; hạ đầu/thân sát bàn hoặc tựa đầu trên tay kéo dài khoảng 1,5 giây; hoặc mở miệng rộng kéo dài kèm tư thế phù hợp với dấu hiệu “có thể ngáp”. Không tính giơ tay phát biểu, cúi viết rõ ngữ cảnh, liếc ngắn hoặc chạm tay lên mặt đơn thuần.

Theo tiêu chí này, **10 học sinh có dấu hiệu rõ**, trong đó **4 học sinh được hệ thống cảnh báo đúng ở mức người trong toàn clip**. Kết quả: **4/10 × 100% = 40%**.

| Mã tham chiếu | Dấu hiệu quan sát trực tiếp | Khoảng thời gian minh họa | Có cảnh báo trong clip |
| --- | --- | --- | --- |
| C | Hạ/ngả đầu, tựa lên tay | 4–7 giây | Chưa ghi nhận |
| D | Quay đầu sang bên/phía sau kéo dài | 3,5–6,5 giây | Chưa ghi nhận |
| I | Hạ thấp đầu/thân sát mặt bàn rồi ngồi thẳng lại | 1,5–10 giây | Chưa ghi nhận |
| K | Mở miệng rộng kéo dài, nghiêng đầu; dấu hiệu có thể ngáp | 4–6 giây | Chưa ghi nhận |
| L | Quay đầu sang bên kéo dài | 0–6,5 giây | Có |
| N | Mở miệng rộng kèm nghiêng đầu; dấu hiệu có thể ngáp | 3,5–4,5 giây | Chưa ghi nhận |
| P | Quay đầu/thân khỏi phía trước | 0–6 giây | Có |
| S | Quay sang phía bạn bên cạnh kéo dài | 0–6 giây | Có |
| T | Gục đầu trên bàn/tay | 0–17,5 giây | Có |
| V | Quay đầu sang bên kéo dài | 12,5–17 giây | Chưa ghi nhận |

| Đại lượng | Kết quả hiện có |
| --- | --- |
| Số học sinh được hệ thống gắn cảnh báo | 4 |
| Tổng số học sinh có dấu hiệu cần chú ý theo đối chiếu trực quan | 10 |
| Số học sinh thuộc nhóm trên được phát hiện đúng | 4 |
| Tỷ lệ phát hiện trên nhóm đối chiếu trực quan | **40%** |

Đây là **ước tính recall theo đối chiếu trực quan trên clip này**, dùng tiêu chí nêu trên; chưa phải kết quả benchmark có nhãn được nhiều người kiểm định. Phép tính đánh giá phát hiện đúng người ít nhất một lần trong clip, không đánh giá độ chính xác thời điểm bắt đầu/kết thúc hay từng nhãn trong 11 kênh. Hai trường hợp mở miệng được ghi là “có thể ngáp”, không suy ra buồn ngủ hoặc lời nói. Các khoảng thời gian là mốc mẫu quan sát, không phải ranh giới hành vi chính xác từng khung.

## 3. Đoạn văn dùng trong báo cáo

> Thử nghiệm trên video lớp học cho thấy hệ thống duy trì tốc độ hiển thị ảnh kèm khung đánh dấu khoảng 29,14 FPS. Trong thời gian phát khoảng 17,8 giây, hệ thống hoàn thành 18 lượt phân tích AI với thời gian phản hồi trung bình khoảng 865 ms/lượt. Đối chiếu trực quan chuỗi ảnh video ghi nhận 10 học sinh có dấu hiệu cần chú ý theo tiêu chí đánh giá, trong đó hệ thống cảnh báo được 4 học sinh, tương ứng tỷ lệ phát hiện 40% trên nhóm đối chiếu này. Các cảnh báo gồm 1 trường hợp gục đầu/thân trên và 3 trường hợp quay lệch hướng lâu. Ảnh và khung đánh dấu được đồng bộ theo cùng mã khung hình; lần chạy không ghi nhận lỗi giao diện, API hoặc luồng bám ảnh.

## 4. Nguồn đối chiếu

- Hiệu năng hiển thị và đồng bộ: `.qa/adaptive_tracking_20261115/live/pixel-report.json`.
- Phản hồi AI, mã học sinh, nhãn và thời điểm: `.qa/adaptive_tracking_20261115/live/recording.json`.
- Độ phân giải, số khung, thời lượng và FPS file xuất: `.qa/adaptive_tracking_20261115/live/encoded.json`.
- Kiểm chứng lần chạy: `.qa/adaptive_tracking_20261115/final-verification.json`.
- Ảnh đối chiếu: `.qa/adaptive_tracking_20261115/source-5s.jpg` và ảnh giữa/cuối video trong thư mục `live/`.
- Chuỗi ảnh rà từng người: `.qa/class3_manual_review/<mã>.jpg`; bảng đối chiếu: `.qa/class3_manual_review/annotations.json`. Script trích ảnh: `.qa/review_class3_manual.py`.
- SHA-256 video kết quả: `FA3303B9C09912676FBF81C7903618485E4CD505527840B6A9EE08234A341207`.
