# SCB lớp học: cài trong repo và kiểm chứng — 12/11/2026

Nguồn được chọn lại là **SCB của tác giả Whiffe/wintonYF**. Charades không thuộc bối cảnh lớp học nên đã bị loại khỏi công cụ demo và đưa các video đã xuất ra khỏi `backend/tests/action_demo`. Không coi kết quả Charades là kết quả lớp học.

## Bộ này dùng để làm gì?

SAV và SCB là **bộ dữ liệu lớp học**, không phải phần mềm quản lý lớp. Ảnh/video đi kèm nhãn dùng để huấn luyện hoặc kiểm tra model. Checkpoint là trọng số model đã học; ONNX là bản xuất để ứng dụng chạy suy luận.

| Bộ | Mục đích trong Student Attention | Hiện có trong repo |
|---|---|---|
| SAV | Phát triển và kiểm chứng nhận diện hành động theo chuỗi video, có thể nhiều nhãn đồng thời | Đã có danh sách nguồn và nhãn; chưa có đủ video gốc hoặc checkpoint đã fine-tune SAV để chạy đầy đủ |
| SCB | Phát hiện vùng học sinh và hành vi trên từng khung hình lớp học | Checkpoint SCB5 chính thức, ONNX CPU và 32 ảnh validation có nhãn; chỉ giơ tay/đọc/viết |

Ứng dụng có thể dùng nhánh SCB để bổ sung bằng chứng đọc/ghi bài/giơ tay cho người đang được theo dõi. Nhãn hành động không tự chứng minh học sinh tập trung hay mất tập trung. SCB5 ba lớp hiện có không nhận diện đủ điện thoại/cúi đầu/ngủ của SCB3 và không thay thế sáu dấu hiệu đang dùng.

## Vị trí cài đặt

Mọi dependency mới cài vào `backend/.venv`. Model ở `backend/models/classroom-actions`; dữ liệu có nhãn ở `backend/tests/datasets/scb5_read_write`. Pip cache, Torch cache, Hugging Face cache, Matplotlib config và tệp tạm nằm trong `backend/.pip-cache`, `backend/.cache` và `backend/.tmp`. Không thay `HOME`, `USERPROFILE`, pagefile hoặc Python hệ thống; Python nền đã có trên máy vẫn có thể được môi trường ảo đọc từ vị trí cũ, còn gói mới được cài trong repo. `PYTHONNOUSERSITE=1` và `PIP_REQUIRE_VIRTUALENV=true` chặn việc dùng/cài gói vào thư mục người dùng.

Kiểm tra lại ngày 12/11/2026: `.venv` hiện dùng Python nền `C:\Users\Admin\AppData\Local\Programs\Python\Python310` đã có sẵn. Vì vậy môi trường chưa độc lập hoàn toàn với ổ C. Các gói AI, trọng số, tập ảnh và đường dẫn cache/temp được kiểm tra đều ở `D:\_CODE\StudentAttention`; lượt kiểm tra không cài gói hoặc tải model.

## Model thực tế đã lấy được

Đã tải checkpoint do tác giả công khai tại [Hugging Face SCB-Dataset](https://huggingface.co/datasets/wintonYF/SCB-Dataset/tree/main), được liên kết từ [repo SCB chính thức](https://github.com/Whiffe/SCB-dataset).

- Revision: `0fdc46fe393d251320def8c6d10cbc95d89f7da6`.
- Checkpoint: `SCB5-Handrise-Read-write-2024-9-17/exp/weights/best.pt`, 74.825.045 byte; SHA-256 `1f93f151286b21c89338fb8e229b218c5b1d061cc7361c042aca6d416a415857`.
- Model YOLOv7, 37.205.480 tham số; ba nhãn gốc `hand-raising`, `read`, `write`.
- **Đây là nhánh SCB5 ba lớp, chưa phải checkpoint SCB3 đủ sáu lớp** `Raise_hand`, `Read`, `Write`, `OnPhone`, `Bow_head`, `Sleep`. Không tự đổi tên nhánh ba lớp thành bản sáu lớp.
- Kiến trúc YOLOv7 chính thức được ghim commit `a207844b1ce82d204ab36d87d496728d3d2348e7`. Chỉ nạp trọng số và xuất ONNX, không huấn luyện/fine-tune.

Đã truy cập danh mục Baidu của tác giả bằng mã trích xuất công khai, tìm thấy gói đại học `0.671k_university_yolo_Dataset.zip` (303.714.326 byte), và các gói trọng số YOLOv8n/s/m/l/x. Việc liệt kê đã thành công; tải gói dataset chưa nhận được URL tệp hợp lệ, tải gói YOLOv8n bị máy chủ tệp trả HTTP 403. Chưa tải được bản sáu lớp, chưa xác minh lớp thực tế trong checkpoint Baidu. Không dùng số liệu của EduYOLO trong bài báo làm số đo trên máy hiện tại.

## Kiểm tra CPU và số đo

Xuất ONNX và kiểm tra PyTorch–ONNX chạy ở hai tiến trình nối tiếp để giảm đỉnh bộ nhớ. ONNX dùng graph nhỏ và tệp trọng số external data, batch một, CPU một luồng. Kiểm tra ba đầu vào gồm ảnh validation thật; sai khác tọa độ tối đa khoảng 0,00666 pixel, kết quả tensor đạt `allclose(rtol=0.001, atol=0.001)`. Phép kiểm tra này chỉ xác minh chuyển đổi số học.

Khóa 32 ảnh validation theo thứ tự tên tệp **trước inference**, giữ nguyên nhãn gốc và SHA-256. Tập mẫu có 139 bbox giơ tay, 14 bbox đọc và 6 bbox viết. Chấm một–một theo từng lớp, IoU từ 0,5; confidence 0,25, NMS IoU 0,45. Không bỏ các bbox bị miss khỏi mẫu số.

| Lớp | Precision | Recall | F1 | TP / FP / FN |
|---|---:|---:|---:|---:|
| Giơ tay | 74,42% | 69,06% | 71,64% | 96 / 33 / 43 |
| Đọc | 34,48% | 71,43% | 46,51% | 10 / 19 / 4 |
| Viết | 20,00% | 16,67% | 18,18% | 1 / 4 / 5 |

Lượt chạy lại toàn bộ `setup:classroom-actions` thành công: trung vị suy luận full frame khoảng 1.531 ms, P95 khoảng 1.970 ms, bộ nhớ riêng đỉnh tiến trình đánh giá khoảng 766 MB. TP/FP/FN và F1 không đổi giữa hai lượt. Đây là số đo riêng model trên 32 ảnh; không phải FPS toàn ứng dụng hoặc độ chính xác video. Mẫu đọc/viết nhỏ nên không suy rộng cho toàn dataset.

Lượt kiểm tra offline mới bằng `npm run verify:classroom-actions` ngày 12/11/2026: 32/32 ảnh được chấm, TP/FP/FN và F1 giữ nguyên; trung vị 1.303 ms/ảnh, P95 1.471 ms, đỉnh bộ nhớ riêng khoảng 768 MB. Kiểm tra ONNX/PyTorch trên ba tensor cũng đạt, sai khác tuyệt đối tối đa 0,00665. Không cài dependency, tải dữ liệu hoặc huấn luyện trong lượt này.

**Chưa lớp nào đạt F1 85% trên mẫu đã khóa, nên SCB chưa được bật mặc định.** Sáu dấu hiệu của hệ thống tiếp tục giữ nguyên. Nhánh SCB thử nghiệm gắn đọc/viết/giơ tay vào ID người, không cần thấy mặt; kết quả nhập nhằng giữa hai người trả `unavailable`. Vẫn cần hai kết quả mới nhất quán để xác nhận, không tăng thời gian từ dữ liệu lặp/quá hạn. SCB là model ảnh nên không được mô tả là đã học chuỗi video SAV.

Kiểm tra luồng camera thật qua HTTP trên video lớp học CDED `class_6.mp4`: 60,084 giây, 111 lượt API, tối đa 35 track, bộ nhớ AI cao nhất 1.398,9 MB, P95 API 1.076 ms. Có một phản hồi mất toàn bộ track, 32 phản hồi mang trạng thái hành động `memory_budget` và chưa có hành động được xác nhận; các phản hồi có thể lặp cùng một lỗi, không phải 32 lần suy luận độc lập. Kết luận kiểm tra này **không đạt**; chưa chạy kiểm chứng SCB 15 phút hoặc bật mặc định một nhánh đã không qua thử ngắn. Nhãn Focused/Distracted của CDED không dùng để chấm các hành động SCB. Số liệu: `.qa/action-demo/stability-scb.json`.

Nhánh MobileViCLIP trước đó còn có lỗi nạp thiếu text projection từ checkpoint. Đã bổ sung kiểm tra để chặn artifact cũ, nhưng chưa hoàn tất chuẩn bị lại sau khi chuyển trọng tâm sang SCB. Các kết quả cũ không đủ để đánh giá chất lượng MobileViCLIP; nhánh này vẫn tắt mặc định.

## Đối chiếu thêm model lớp học nhỏ

Đã kiểm tra thêm checkpoint từ [AI-Smart-Classroom-Monitoring-System của rukeshsg](https://github.com/rukeshsg/AI-Smart-Classroom-Monitoring-System), commit `5ee923f92a6ac04bd3e83566e87567d771b2a8f8`, tệp `models/behavior_yolo.pt`. Checkpoint 24.487.143 byte, SHA-256 `64057cc20aad3cce9016d6cedea3a2d760f7d76325a6d99e72f795003fa1a76d`; 3.012.213 tham số. Đã xác minh bên trong có bảy nhãn `Fighting`, `Sleeping`, `Using Phone`, `Reading`, `Writing`, `Hand Raising`, `Eating`. Đây là model cộng đồng, không phải trọng số SCB do Whiffe phát hành.

Model tải vào `.qa/action-demo/classroom-candidates` trong repo. Chỉ nạp với danh sách lớp pickle cho phép, không chạy source tải từ repo bên ngoài; xuất ONNX và kiểm tra tương đương trên ba đầu vào ở hai tiến trình nối tiếp. Không fine-tune hoặc bật trong ứng dụng.

Chấm đúng 32 ảnh đã khóa, chỉ ba lớp chung có nhãn; bốn lớp còn lại không được tính đúng hoặc tính đạt:

| Lớp | Precision | Recall | F1 | TP / FP / FN |
|---|---:|---:|---:|---:|
| Giơ tay | 31,25% | 7,19% | 11,70% | 10 / 22 / 129 |
| Đọc | 1,96% | 7,14% | 3,08% | 1 / 50 / 13 |
| Viết | 0,00% | 0,00% | 0,00% | 0 / 1 / 6 |

Trung vị 119,42 ms/ảnh, P95 131,40 ms, bộ nhớ riêng đỉnh tiến trình đánh giá khoảng 554 MB. Model nhỏ hơn và nhanh hơn SCB5 YOLOv7 nhưng không qua kiểm chứng chất lượng trên tập mẫu này, nên **không tích hợp**. Kết quả không đo được độ chính xác ngủ/điện thoại/ăn hoặc hành động video. Số liệu và script kiểm tra nằm ở `.qa/action-demo/classroom-candidates`.

Nguồn khác [Henry1314520/objection-detection](https://github.com/Henry1314520/objection-detection) công khai link model được mô tả có 20 nhãn. Chưa xác minh được checkpoint trong giới hạn tải kiểm tra 32 MB; không coi mô tả YOLO11n hoặc số lớp trong README là kết quả chạy thực tế. Không bật model này.

## Tái lập

Nếu đã có model như máy hiện tại, chạy từ thư mục gốc repo:

```powershell
npm run verify:classroom-actions
```

Lệnh kiểm tra offline vị trí Python/package/cache/temp, SHA-256 checkpoint/ONNX/trọng số và 32 cặp ảnh–nhãn; tiếp đó chạy kiểm tra tương đương số học và chấm lại tập validation. Không gọi pip, không tải mạng, không xuất lại model. Báo cáo vị trí cài đặt ở `.qa/action-demo/scb/installation-check.json`, điểm nhận diện ở `.qa/action-demo/scb/validation.json`. Lệnh chạy thành công nghĩa là kiểm tra đã thực thi xong; cần xem `passed` trong báo cáo để biết model có qua ngưỡng chất lượng hay không.

Chỉ khi cần chuẩn bị lại checkpoint và bản xuất, chạy lệnh cài đặt sau.

Từ `backend`:

```powershell
npm run setup:classroom-actions
```

Lệnh cài ba thư viện phụ thuộc vào `.venv`, kiểm tra checkpoint/source/sample, xuất graph, xác minh ONNX trong tiến trình riêng và chấm lại đúng 32 ảnh đã khóa. Tất cả đường dẫn cache/temp do `backend/local-ai-env.mjs` ép về repo.

Thử nhánh SCB trên ứng dụng bằng `$env:AI_CLASSROOM_ACTIONS='1'` trước `npm start`; đây là chế độ thử nghiệm chưa đạt ngưỡng, không phải cấu hình đã chốt. Đặt `AI_CLASSROOM_ACTIONS=0` hoặc bỏ biến này để trở về cấu hình mặc định. Kiểm tra API như camera: `node scripts/check-action-stability.mjs --seconds 60 --scb`. Dữ liệu trung gian ở `.qa/action-demo/scb`; không ghép ảnh validation thành video giả để chấm thời gian hay độ trễ.

Hiện chưa có hai demo lớp học đủ tình huống/nhãn để kết luận sáu biểu hiện và 15 hành động đạt 85%.
