# Theo dõi người và thử nghiệm 15 hành động SAV — 12/11/2026

Cập nhật sau khi kiểm tra nguồn: chuyển thử nghiệm sang dữ liệu SCB lớp học, loại Charades khỏi demo. Artifact MobileViCLIP cũ bị chặn vì thiếu text projection đã học, nên các lượt cũ chưa đủ để đánh giá chất lượng model. [Trạng thái SCB, cài trong repo và số đo mới](SCB_LOP_HOC_CAI_DAT_VA_KIEM_CHUNG.md) là thông tin hiện tại; các số đo SAV bên dưới giữ lại làm lịch sử thử nghiệm.

Sáu dấu hiệu của báo cáo được giữ nguyên về phạm vi: nhắm mắt, điện thoại, cúi đầu, ngáp, nói chuyện và laptop. Phần mở rộng sử dụng MobileViCLIP-Tiny đã huấn luyện sẵn, không fine-tune. Đây là **thử nghiệm zero-shot**, không phải checkpoint đã huấn luyện trên SAV và chưa đạt kiểm chứng 85%.

## Luồng xử lý đã triển khai

YOLO11s/ByteTrack quản lý người; VitTrack cập nhật bbox người trên ảnh hiện tại. Mặt là bằng chứng tùy chọn gắn vào cùng người. Bbox người, mặt và đồ vật là ba lớp riêng; mất mặt không đồng nghĩa người biến mất. Khi không thấy mặt, không giữ bbox mặt cũ hay tự suy ra mắt nhắm. Nhánh quét người chạy riêng với nhánh hành động để transformer chậm không chặn việc cập nhật người.

Điện thoại/laptop dùng liên kết người–tay–đồ vật và timestamp nguồn, kể cả không thấy mặt. Hành động đọc/ghi bài đã xác nhận có thể tạo ngữ cảnh học tập khi mặt chưa đủ rõ; một cuốn sách được nhìn thấy đơn thuần không đủ để kết luận đang đọc. Gục bàn cần đồng thời bằng chứng chuỗi video và tư thế thân người. Nhãn chỉ nói “có thể ngủ”, không khẳng định người đang ngủ.

Mỗi hành động được đánh giá riêng. Ngồi, đọc và ghi bài có thể cùng xuất hiện. Hai nhóm loại trừ là ngồi/đứng và nhìn trước/nhìn sang bên. Một kết quả lặp timestamp không được dùng như hai lần quan sát. Mỗi nhãn cần ít nhất hai kết quả mới nhất quán; dữ liệu quá 2,5 giây bị coi là thiếu quan sát. Mô hình chỉ dùng tám khung hình đã xuất hiện, không đọc tương lai.

Ngưỡng mới: mắt 1,2 giây; điện thoại 0,6 giây; cúi đầu 1 giây; ngáp 0,7 giây; nói chuyện 1,5 giây với ít nhất ba chu kỳ miệng; laptop 1 giây; gục bàn 1,5 giây. Cảnh báo đã xác nhận giữ 5 giây. Cười rõ ở cả hai bên miệng không được dùng riêng để xác nhận nói chuyện.

## Model và máy hiện tại

Máy được kiểm tra: Intel Core i5-10310U, 4 lõi/8 luồng, RAM 16 GB, Intel UHD; không có GPU NVIDIA.

Checkpoint Tiny và checkpoint nền Apple được kiểm tra SHA-256 theo `backend/ai/action_model.json`. Adapter giữ nguyên lớp và trọng số, bỏ import huấn luyện/CUDA không dùng, tắt gradient checkpointing và hợp nhất nhánh bằng hàm chính thức để xuất ONNX. Tạo vector văn bản một lần; runtime chỉ nạp graph video và vector, không nạp text encoder.

Kiểm tra trên năm tensor khác nhau: sai lệch tuyệt đối ONNX/PyTorch tối đa khoảng 0,0000011; hợp nhất nhánh so với graph chưa hợp nhất khoảng 0,0000031. Đây là kiểm tra tương đương số học, **không phải độ chính xác nhận diện**.

Đo graph ONNX riêng với hai luồng CPU: trung vị khoảng 786 ms/chuỗi/người, P95 khoảng 816 ms; thêm khoảng 155 MB bộ nhớ riêng ở đỉnh. Đây là tốc độ chạy một graph, chưa gồm theo dõi, mặt, tay và đồ vật. Ngay cả khi chỉ tính hành động, ước lượng mới đáp ứng khoảng hai người trong chu kỳ hai giây; chưa đủ cho 40 người. Vì vậy nhánh 15 hành động **không được bật mặc định**. Không thử bản Small vì Tiny đã không đạt ngân sách cập nhật cho lớp đông.

Nhánh thử nghiệm giới hạn bộ nhớ toàn cây AI khoảng 2 GB, giữ một snapshot mới nhất cho mỗi người; khi thiếu bộ nhớ, nhường nhánh hành động và trả `unavailable`. Không thay pagefile hoặc dừng ứng dụng khác. Số liệu thử tự động qua API nằm tại `.qa/action-demo/stability.json`; độ ổn định không thay thế đo precision/recall.

## Nhãn, dữ liệu và phần chưa hoàn tất

Đủ 15 tên nhãn được giữ theo tài liệu SAV: `sit`, `stand`, `look_forward`, `look_sideways`, `read`, `flip_books`, `touch_sth`, `raise_hand`, `hands_down`, `take_notes`, `applaud`, `bend`, `turn_around`, `talk_with_others`, `answer_questions`. `slumped_on_desk` là tư thế bổ sung, không được gọi là nhãn SAV thứ 16.

Đã tải danh sách nguồn, danh sách clip, nhãn và bbox validation SAV: 865 clip, 78.898 dòng nhãn hành động. Lựa chọn 13 clip được khóa trước inference để mỗi nhãn có ít nhất năm clip. Hiện chưa có video gốc cho các clip đã chọn. Ba URL Youku ở đầu, giữa và cuối danh sách tác giả đều trả lỗi -6004/hạn chế phát. Đã kiểm tra thêm danh mục công khai Hugging Face, Kaggle và tìm nguồn khác nhưng chưa xác minh được bản video SAV thay thế. Không dùng CDED-7, ảnh tĩnh hoặc nhãn gốc để giả kết quả video SAV.

**Chưa giao được hai video demo có đủ nhãn, chưa có precision/recall/F1 SAV và chưa chốt 85%.** Khi có media thật, công cụ ghép đoạn và replay sẽ chạy theo FPS nguồn qua API thực, bỏ khung cũ khi AI bận thay vì làm chậm camera, reset phiên tại ranh giới clip và dùng chính component bbox của frontend. Thư mục `backend/tests/action_demo` chỉ nhận hai MP4 hoàn tất; dữ liệu kiểm tra nằm riêng trong `.qa/action-demo`.

Chấm theo bbox người, ghép một–một IoU từ 0,5. Nhãn dương bị bỏ sót hoặc `unavailable` được tính là FN, dự đoán dư là FP; không bỏ chúng khỏi mẫu số. Tính riêng từng nhãn và độ phủ. Kết quả chỉ được chốt cho hai video khi đủ tình huống và các nhóm yêu cầu đạt F1/độ phủ ít nhất 85%; nhãn không có mẫu không được tính đạt.

## Lệnh tái lập

Từ `backend`:

```powershell
npm run setup:actions
npm run test:action-stability
```

Thử tìm nguồn SAV và khóa bộ clip, từ thư mục gốc:

```powershell
backend\.venv\Scripts\python.exe backend/scripts/prepare-action-demo.py --probe-public
```

Nếu có nguồn SAV cục bộ, thêm `--source-dir DUONG_DAN`. Ưu tiên video gốc đặt tên dạng `20211212_04.mp4`; công cụ lấy đúng mốc cắt theo script tác giả `(index - 1) * 2 + 1,5`, kèm ba giây thực trước đoạn chấm. Clip ba giây riêng lẻ không có phần trước nguồn sẽ bị báo thiếu warmup; không lặp khung đầu để giả khởi động. Chuyển FPS chỉ lấy khung đã xuất hiện, không làm tròn lên khung tương lai.

Video bổ sung cần manifest `.qa/action-demo/supplement-manifest.json` với `annotationSource` là `published_ground_truth` hoặc `human_verified`, và `segments` gồm `path`, `sha256`, `startSeconds`, `endSeconds`, `preRollSeconds` (ít nhất 3), `annotations`, `scenarios`. Mỗi annotation có `timeSeconds` theo video nguồn, sau phần warmup; `people` gồm bbox chuẩn hóa và danh sách nhãn. Nhãn không được tạo từ dự đoán của model đang kiểm tra. Các tình huống cần có trong `scenarios`: `face_hidden_slump`, `face_return`, `same_position_different_person`, `object_between_people`, `camera_source_change`, `turn_face`, `smile`, `reading_head_down`. Thiếu tình huống nào sẽ được liệt kê và không chốt đạt.

Công cụ báo độ trễ phản hồi API và tuổi bằng chứng lúc trả kết quả. Nhãn SAV ở keyframe không xác định thời điểm bắt đầu hành động; vì thế độ trễ từ lúc hành động bắt đầu được ghi chưa đo được, không thay bằng thời gian suy luận model.

Khi dữ liệu đã đủ, từ `backend` chạy `npm run demo:actions`. Lệnh dừng với lý do cụ thể nếu thiếu nguồn/nhãn; không tạo MP4 giữ chỗ. Thử nghiệm live cần đặt `AI_ACTIONS_EXPERIMENTAL=1` trước khi khởi động backend; cấu hình này không phải xác nhận model đạt 85%.

Nguồn: [SAV chính thức](https://github.com/Ritatanz/SAV), [MobileViCLIP chính thức](https://github.com/MCG-NJU/MobileViCLIP), [MobileCLIP nền](https://github.com/apple-aiml-research/ml-mobileclip).


## Kết quả chạy ổn định qua API — 12/11/2026

Đã chạy 900.6 giây, 1607 lượt nhận diện, phát nguồn theo đồng hồ 30 FPS. Số người đồng thời cao nhất 30; bộ nhớ riêng cao nhất toàn cây AI 1371.1 MB; P95 một lượt API 1455 ms. Đây là tốc độ API, không phải FPS của video và không phải độ chính xác hành vi.

Trong lượt này có 80 phản hồi không còn người sau khởi động và 0 phản hồi có hành động được xác nhận. Độ phủ kết quả hành động còn mới trên các track người là 0.00%. Kết luận đạt đầy đủ: **false**. Các số liệu này không chứng minh đạt 85%; nhánh hành động tiếp tục bị tắt mặc định. Xem số đếm/lỗi thực tế tại `.qa/action-demo/stability.json`.

Kiểm tra cấu hình mặc định (không bật nhánh hành động thử nghiệm): 60.1 giây, 108 lượt, tối đa 30 người, bộ nhớ cao nhất 1180.7 MB, P95 API 1019 ms, 0 phản hồi mất toàn bộ track, không ghi nhận lỗi pipeline. Đây là kiểm tra ngắn 60 giây, không thay thế kết quả 15 phút của nhánh thử nghiệm.

Kiểm tra trình duyệt với kết quả API thật: 22 bbox người, 19 bbox mặt và 5 bbox đồ vật khớp tọa độ; 4 người không thấy mặt vẫn giữ bbox người. Component thực tế được dùng trực tiếp, không dựng lại hình học ở công cụ kiểm tra. Ảnh đối chiếu: `.qa/action-demo/person-overlay.png`; số liệu: `.qa/action-demo/overlay-check.json`. Không dùng phép kiểm tra hiển thị này để suy ra độ chính xác nhận diện.
