# Quan sát hướng đầu, quay thân và gục thân trên

## Đối chiếu từng người theo hướng camera — 15/11/2026

Mốc bình thường là nhìn thẳng về camera (`AI_CAMERA_YAW_DEG=0`), theo yêu cầu người dùng. Hướng từ mặt và từ keypoint thân được giữ bằng bộ đếm riêng: đổi nguồn không xóa toàn bộ lịch sử, cũng không cộng các lần quay từ hai nguồn thành một. Proxy mũi/tai được đổi dấu để thống nhất với yaw của mặt và chuyển sang góc ước lượng phi tuyến; đây không phải số đo góc chính xác. Nguồn keypoint thân cần thêm biên 5° khi bắt đầu xác nhận quay lệch. Không học tư thế đang quay/gục làm hướng bình thường.

Pose mặt có kiểm chứng từ ảnh gốc rộng ít nhất 32 px có thể cung cấp hướng đầu dù chưa đủ chi tiết mắt/miệng. Ngưỡng mắt và nói chuyện 64 px vẫn giữ. Tham chiếu khuỷu tay dùng ba ảnh độc lập với nhịp AI thực tế, không đòi ba mẫu trong 1,2 giây khi hệ thống đang lấy mẫu chậm hơn.

Ghép mặt/thân cần ít nhất 80% vùng mặt nằm trong thân có dung sai; mặt đã biết chủ được ưu tiên giữ chủ. Hai bbox chồng lên cùng một đầu không tự tạo hai học sinh; trường hợp hai đầu riêng hoặc người gục có bằng chứng riêng vẫn giữ riêng. Mã mặt bị xóa khi không còn mặt quan sát được; ID thân đang tồn tại được ưu tiên hơn alias chỉ có mặt.

CPU dùng một session YOLO11s riêng cho đồ vật: một ảnh toàn cảnh và tối đa một crop luân phiên, không dùng chung buffer với detector thân. Chuỗi kiểm chứng nhiều lần YOLO11m từng làm kết quả quá hạn nên đã được bỏ. Laptop cần điểm lớp ít nhất 0,65; điện thoại/sách giữ ngưỡng 0,2. Không tăng điểm model, không coi bbox laptop là tương tác. Nhánh ngáp có miệng mở vừa phải cần thêm bằng chứng nhắm mắt hai bên; âm miệng ngắn không xóa toàn bộ lịch sử nói chuyện. Biên 5° của proxy thân chỉ áp dụng lúc khởi tạo ứng viên quay đầu; sau đó vẫn tích lũy trên ngưỡng đã cấu hình. Chi tiết kiểm tra riêng tại `.qa/camera_behavior_improvement`.

Bản hiện tại bỏ suy luận mức tập trung: không nạp CavT, không tạo điểm CavT và không xuất trạng thái `focused`. Giao diện có hai nhãn **AI đang quan sát** và **Cần chú ý**. Các giá trị `uncertain`/`needs_attention` trong API được giữ để tương thích; chúng biểu diễn trạng thái quan sát/cảnh báo. Bộ cài mặc định cũng bỏ tải và chuẩn bị CavT. Các trọng số CavT cũ không bị xóa khỏi máy.

## Nhãn ghim tại góc khung, video tự động đúng tốc độ — 15/11/2026

Khung mặt dùng viền vuông 2 px xanh/đỏ; khung thân xanh dương/đỏ, đồ vật vẫn có lớp riêng. Nhãn nhỏ nền tối gắn sát góc trên bên phải. Nhãn lấy vị trí từ chính bbox đang vẽ ở mỗi khung; đổi độ dài cảnh báo tại chỗ, không fade/slide/bay vào. Luồng hiện tại không nội suy hình học bbox từ AI. `pixel_tracking.py` đo chuyển động ảnh trong process riêng; phản hồi AI cấp nguồn khởi tạo/hiệu chỉnh có frame ID và cập nhật nhãn/màu. Bbox nguồn cũ phải được chiếu qua chuyển động pixel thật đến ảnh hiện tại. `PixelPreview` vẽ cùng một ImageBitmap và geometry frame ID trong một lượt commit; bộ theo dõi không lùi khi HTTP đến sai thứ tự. Luồng AI JPEG lấy bản sao của chính ảnh có ID đó.

Kiểm tra mới gồm bám đủ ba lớp khi AI không trả kết quả mới, khởi tạo bbox muộn hơn 1 giây trên vật đang di chuyển, giữ đúng pixel khi HTTP chậm và frame ID tiếp tục tăng sau tạm dừng/tiếp tục. Kiểm thử luật không thay thế đánh giá nhận diện: toàn bộ 11 biểu hiện chưa có đủ ground truth độc lập. Mặt dưới 64 px hoặc mí mắt không đủ chi tiết không tạo kết luận nhắm mắt; bbox vẫn được giữ.

Khởi tạo người gục nay có thêm nhánh ba ảnh tư thế dương tính nhất quán, trong đó ít nhất một ảnh mạnh, cùng bằng chứng người độc lập. Nhánh hai ảnh mạnh vẫn giữ. Các ảnh phải khác timestamp, nằm trong cửa sổ 2 giây; không tăng điểm model hoặc tạo người từ một ảnh/cue đơn lẻ. Điều này tránh bỏ lỡ người gục sẵn khi thời điểm lấy mẫu ban đầu đổi nhẹ.

Lượt `.qa/class_3_realtime_1794717705666_pinned_realtime` chạy frontend production/API/model thật tự động, nguồn phát một lần 1×; không seek/dừng/thay ngưỡng/thao tác khi phát. Đủ 533 khung nguồn, không rớt khung; preview 29,91 FPS. Có 27 phản hồi AI, P95 605 ms. Nhãn gắn đúng góc ở 172 mẫu live có bbox và ở mọi khung trong 533 khung xuất; không có hiệu ứng vào. Người gục có bbox từ khoảng 1,85 giây, cảnh báo từ khoảng 3,78 giây đến hết clip, cùng ID và không mất khung/cảnh báo.

Chỉ xuất `backend/tests/test_results/class_3.mp4`, H.264, 1906×1080, 30 FPS; đủ mọi khung và timestamp gốc, SHA-256 nguồn không đổi. Camera phát độc lập khi AI xử lý; nhịp AI không được coi là FPS video. Ảnh/báo cáo chỉ ở `.qa`. Các kiểm tra mới bắt buộc nhãn ghim góc, không có hiệu ứng vào trước khi công bố video.

## Nhận diện gục khi khuất mặt, không chỉ có bbox — 14/11/2026 (lượt trước)

Lỗi trước đây: em áo đen gục sau bạn áo xám có bbox `U` nhưng không có cảnh báo. Nhánh gục yêu cầu điểm YOLO người ≥ 0,1 nên chặn cả người đã được hai mô hình xác nhận qua thời gian; dữ liệu tư thế chờ detector người và bị xét quá hạn sau thời gian suy luận. Các lượt kiểm tra chỉ đếm bbox trước đó chưa chứng minh đã nhận ra hành vi này.

Hiện tại lưu rõ bằng chứng xác nhận qua hai mô hình, giữ nguyên điểm YOLO yếu và thời điểm đo gốc. `RestBodyTracking` tiếp tục người đã được xác nhận bằng các bbox tư thế mới, cùng ID, kể cả khi detector người tổng quát hụt. Model tư thế không được tự tạo người mới; ghép mơ hồ bị từ chối, ảnh âm tính không làm mới mẫu dương, mất hỗ trợ quá 2 giây phải xác nhận lại. Ghép kết quả vào body trước khi xuất API, không tạo bbox mặt giả. Tọa độ và timestamp của mỗi lần đo được giữ riêng; camera vẫn phát độc lập.

Nhánh hành vi dùng thời điểm ảnh hiện tại để xét tuổi bằng chứng người, vẫn yêu cầu ảnh còn mới và chuỗi mẫu gục đủ 1,5 giây. Bộ bám người gục chỉ hỗ trợ khi có phát hiện tư thế mới thực sự; phản hồi lặp lại/cached không làm đủ thời gian hoặc gia hạn cảnh báo. Pose đứng/ngồi thẳng rõ vẫn phủ định gục. Ngưỡng gục tùy chỉnh của phiên tiếp tục áp dụng.

Lượt `.qa/class_3_realtime_1794671943463` qua frontend production/API/model thật: em áo đen có bbox từ khoảng 1,91 giây, cảnh báo `U · Gục người` từ khoảng 4,05 giây đến hết clip, cùng ID người 24. Không mất bbox sau phát hiện đầu; 19/19 phản hồi sau lúc xác nhận đều còn cảnh báo từ mẫu mới, không chỉ giữ cảnh báo cũ. Video xuất hiện nhãn từ giây 4, đủ 413 khung liên tiếp có cả cảnh báo và khung thân. Đã nhìn đối chiếu ảnh giữa video để kiểm tra đúng em áo đen.

Nguồn phát một lần 1× không thao tác, SHA-256 không đổi; preview khoảng 29,82 FPS. Video duy nhất `backend/tests/test_results/class_3.mp4` giữ đủ 533 khung nguồn, 30 FPS, H.264. Ba lớp người/mặt/đồ vật đều hoạt động; không lỗi model/API/frontend trong lúc phát. 82 kiểm thử backend và 191 Python, TypeScript/build đạt. Ảnh và báo cáo chỉ ở `.qa`.

## Nhãn góc trên phải, mặt và thân cùng lượt — 14/11/2026 (lượt trước)

Nhãn người neo vào góc trên bên phải khung thân, không đổi vị trí theo mặt hoặc tự nhảy để né nhãn khác. Nhãn mặt đơn và đồ vật dùng cùng quy tắc với khung tương ứng. Nếu sát mép trên, nhãn đặt vào trong khung để không bị cắt. Ba lớp SVG dùng chung một lần đo viewport; một người có cả mặt/thân chỉ có một nhãn trên khung thân.

Backend nhận khung thân hoàn tất trong lúc dò mặt vào cùng phản hồi, không cập nhật bộ bám pixel hai lần trên một ảnh. Riêng lúc chưa có kết quả dò người đầu tiên, AI chờ tối đa 750 ms; các lượt tiếp theo không đợi lần quét mới. Camera vẫn phát độc lập. Kết quả dò người rỗng, lỗi hoặc quá hạn không tạo khung thân giả; người khuất mặt vẫn có thể giữ khung thân.

Lượt `.qa/class_3_realtime_1794662163554`: phản hồi đầu sau khoảng 0,63 giây có 20 khung thân và 16 khung mặt, cả 16 mặt đều đi kèm thân trong cùng phản hồi. Người gục kiểm tra có bbox từ khoảng 1,86 giây, giữ cùng ID đến hết clip. Preview 29,88 FPS; video duy nhất `backend/tests/test_results/class_3.mp4` đủ 533 khung, 30 FPS, nguồn không đổi và không có lỗi model/API/frontend trong lúc phát. 153 kiểm thử frontend, 181 Python, TypeScript và build đạt. Kiểm tra Chrome trên component thật xác nhận nhãn góc phải và 14 cặp mặt/thân cùng tồn tại qua 21 mẫu chuyển động.

## Bbox gọn, bám người gục sẵn — 14/11/2026 (lượt trước)

Nhãn camera nền tối, một dòng 25 px; bình thường chỉ hiện mã người, cảnh báo dùng dấu hiệu ngắn và ưu tiên gục người. Viền thân xanh dương, mặt xanh bạc hà, đồ vật vàng, cảnh báo đỏ hồng. Mô tả đầy đủ vẫn có trong danh sách và thông tin truy cập của nhãn. SVG chuyển liên tục giữa các đích AI đã hoàn tất bằng một vòng `requestAnimationFrame`; video gốc phát độc lập.

YOLO11s yếu ở người đã gục từ đầu được đối chiếu với hai lần quan sát tư thế trên ảnh khác nhau. Sau xác nhận, khung thân lấy phạm vi mô hình tư thế; không tạo bbox mặt khi mặt bị che. Hai luồng dùng lịch sử tư thế giới hạn, lấy kết quả cùng hoặc trước thời điểm ảnh người, tối đa 1.500 ms. Điểm dương giảm tạm thời có ngưỡng tiếp tục riêng; ảnh người vắng/mơ hồ không làm mới thời điểm bằng chứng gốc. Điểm yếu không được nâng thành bằng chứng hành vi mạnh.

Lượt thực tế `.qa/class_3_realtime_1794660085662` phát `class_3.mp4` một lần 1× qua frontend production và API/model thật, không thao tác khi phát. Người gục kiểm tra có bbox thân từ khoảng 1,8 giây, cùng ID `U`/26 ở 22/22 phản hồi tiếp theo; không mất khung trong 481 khung video xuất từ lần xuất hiện đầu. Preview khoảng 29,68 FPS; không có lỗi model/API/frontend trong lúc phát. Cả ba lớp bbox hoạt động. 176 kiểm thử Python đạt; frontend 150 kiểm thử, TypeScript và build đã đạt.

Chỉ xuất `backend/tests/test_results/class_3.mp4`: H.264, 1906×1080, đủ 533 khung gốc ở 30 FPS. Mọi timestamp khung trùng nguồn; SHA-256 nguồn không đổi. Ảnh và dữ liệu chẩn đoán nằm trong `.qa`. Chạy lại bằng `node frontend/scripts/replay-camera-video.mjs --file backend/tests/videos/class_3.mp4 --output backend/tests/test_results`. Các mục ngày 13/11 dưới đây là lịch sử, không mô tả cách nội suy hoặc tên file hiện tại.

## Video đúng tốc độ nguồn, bbox chỉ đổi khi AI trả kết quả — 13/11/2026 (lịch sử)

Lỗi đứng hình vừa sửa nằm ở frontend: `<canvas class="processed-video">` phủ lên video và chỉ đổi ảnh khi API hoàn tất, khiến tốc độ camera hiển thị bằng tốc độ AI. Hiện tại webcam dùng trực tiếp `<video>`, Pi dùng ảnh MJPEG; không có canvas ảnh phân tích phủ lên camera. Backend tiếp tục chạy các model cũ. Encoder worker chụp ảnh mới khi request trước xong; không tích hàng đợi ảnh cũ và không chạy nhiều request suy luận chồng nhau.

Canvas `.analysis-frame` luôn `hidden`/`display:none`, giữ đúng ảnh đã gửi để cắt mặt trong danh sách Cần chú ý. Vẫn chụp từ `faceBox` gốc; không cắt từ camera live đang ở thời điểm khác. Pause/tắt/reset vẫn hủy quyền công bố kết quả muộn, xóa bbox theo vòng đời trước đây. AI chậm, lỗi hoặc đang thử lại không được che/dừng video camera.

Theo yêu cầu mới nhất, `useLiveOverlays` giữ nguyên bbox người/mặt/đồ vật của quyết định AI cuối cùng, không chạy timer tự ẩn, nội suy hoặc hiệu ứng opacity giữa hai kết quả. Khi AI trả kết quả mới thì thay toàn bộ lớp bbox; kết quả cảnh trống thì xóa. Request lỗi tạm thời đang retry cũng giữ quyết định trước đó; pause/reset/tắt/đổi nguồn vẫn xóa theo vòng đời. Bbox là tọa độ AI đã quyết định, có thể chậm so với người đang chuyển động; video vẫn phát độc lập. Không dùng chuyển động giả để làm bbox có vẻ theo kịp video.

Video xem hiện tại: `backend/tests/test_results/v1.mp4`. Đã dọn ảnh, báo cáo và video thử cũ khỏi thư mục này. Chạy `node frontend/scripts/replay-camera-video.mjs`: lần tiếp theo tự xuất `v2.mp4`, rồi `v3.mp4`… Chỉ công bố khi đã kiểm tra giải mã và phát Chrome; sau đó bỏ video phiên bản cũ để thư mục luôn chỉ giữ một video. Ảnh/báo cáo/JPEG đầu vào nằm riêng trong `.qa/demo-vN_...`, không xuất kèm vào `test_results`. Tên `--tag` chỉ đánh dấu thư mục chẩn đoán, không thay tên phiên bản.

Demo dùng duy nhất nguồn `class_3.mp4`, một lần 1×, không tua/dừng/chỉnh ngưỡng/thao tác trong lúc phát; frontend production/API/model backend thật. Sau lượt chạy, lớp bbox được render bằng chính component React của frontend. Bộ ghép đọc lại từng khung nguồn, giữ đủ **533 khung 1906×1080 ở đúng 30 FPS nguồn**, không lấy ảnh video từ screencast hoặc lặp khung để đủ FPS. Lớp bbox chỉ thay tại khung đầu tiên sau thời điểm AI hoàn tất đo trên đồng hồ video nguồn; không áp ngay tại thời điểm ảnh đầu vào được chụp. Do đó không dùng được thông tin tương lai để vẽ sớm. Bản mặc định hiện tại là ghép khung gốc và quyết định AI; thêm `--screencast` chỉ để chẩn đoán bản quay giao diện thực tế.

| Số đo khi ghi giao diện | Kết quả |
|---|---|
| Nguồn / thời gian phát thực | 17,786 / 17,866 giây, 1× |
| Video xuất | Đủ 533 khung nguồn, 30 FPS; lớp bbox giữ nguyên giữa các quyết định |
| Camera giả lập trình bày trong trình duyệt | Khoảng 26,21 FPS; chỉ là số đo preview, không quyết định FPS video xuất |
| Nhịp AI | Khoảng 1,34 phản hồi/giây; 24 phản hồi trong lúc phát |
| P50 / P95 HTTP AI | 623 / 722 ms |
| Mất toàn bộ bbox trong phản hồi sau phát hiện đầu | 0 |
| Lỗi model / API / JavaScript | 0 / 0 / 0 |
| Bộ nhớ riêng AI cao nhất được lấy mẫu | 916,2 MB |

Kiểm thử frontend, TypeScript và build đạt; có hồi quy mới giữ quyết định khi retry, thay bằng cảnh trống và giữ bbox qua thời gian dài. 159 kiểm thử Python đạt, gồm kiểm tra ranh giới khung khi quyết định AI hoàn tất, không áp kết quả tương lai và giữ đủ khung khi chưa có quyết định. Bài trình duyệt `npm --prefix frontend run test:realtime` cố ý làm inference chậm 1.200 ms rồi chặn request hơn 3 giây: pixel video tiếp tục đổi, tọa độ bbox giữ nguyên và nút tạm dừng vẫn hoạt động. Chạy thêm `REALTIME_SOURCE=pi` để thử Pi giả lập. Chụp mặt vẫn lấy từ canvas phân tích, không lấy từ ảnh live khác thời điểm. Bằng chứng `.qa/realtime-tracking.json`, `.qa/realtime-tracking-pi.json`, `.qa/class_3-realtime-nguyen_fps_bbox_ai_v2`.

Chưa đo FPS webcam/Pi vật lý và chưa có nhãn chuẩn để khẳng định độ đúng từng bbox/cảnh báo. File xuất là bản ghép khung nguồn với quyết định AI đã đo ở lượt realtime, không phải bản quay màn hình. Thời lượng từ 533 khung/30 FPS là 17,767 giây; metadata container nguồn là 17,786 giây, chênh dưới một khung. Các mô tả tự hết hạn bbox 2,5 giây và đồng bộ ảnh hiển thị trong các bản lịch sử không còn áp dụng.

## Sửa mất bbox và chạy lại class_3 trước khi tách preview — 13/11/2026

Video bàn giao hiện tại: `backend/tests/test_results/class_3_realtime_da_sua_2.mp4`, báo cáo `class_3_realtime_da_sua_2_report.json`, ảnh đầu/giữa/cuối và ảnh toàn giao diện cùng thư mục. `frontend/scripts/replay-camera-video.mjs --tag da_sua_2` dùng frontend production, HTTP API và model thật của backend. Camera giả lập phát riêng video nguồn một lần ở 1×; không seek, tạm dừng, đổi ngưỡng, sửa model hoặc thao tác giao diện trong lúc phát. Các thao tác bật/đặt khung xảy ra trước khi chạy, tắt để dọn phiên xảy ra sau khi nguồn kết thúc. Không mở camera/Pi thật. Lần chạy này đã kiểm tra sự kiện media, không dùng clock video thay thời gian thật hoặc khóa serialize native.

Nguyên nhân đã sửa:

- Nhiều native tracker và việc chạy bù lịch sử khiến kết quả dò mặt nền đến sau hạn bằng chứng. Cảnh trên tám mặt/người nay chạy cùng detector SCRFD-10G/YuNet trên ảnh đang xử lý, giữ điều kiện xác minh cũ, không chạy riêng một tracker cho từng mặt. Kết quả âm tính hiện tại vẫn làm mặt biến mất; không kéo dài cache để tạo mặt đang thấy.
- Template thân chạy đuổi theo lịch sử liên tục, rồi bị hủy vì chậm hơn hai ảnh. Công việc nay chỉ chạy tới ảnh mẫu mới nhất một lần, bàn giao trước lượt tracking hiện tại. Vẫn kiểm tra generation, ID được phép, kích thước ảnh và thời hạn. Native đo thân thành công trên ảnh hiện tại có thể tiếp tục tối đa 5 giây từ lần dò người độc lập; thất bại tracking hoặc lượt dò rỗng không được giữ bbox. Timestamp dò người không được gia hạn từ việc bám hình.
- Ở cảnh đông, lấy snapshot thân mới nhất sau lượt dò mặt trực tiếp, khi model người đã có thêm thời gian xử lý cùng ảnh. Model gục bàn chạy luồng riêng để không chặn công bố YOLO11s; bằng chứng của nó vẫn có timestamp gốc và phải đối chiếu người YOLO11s.
- Tiến trình con Windows tự đặt OpenCV mặc định một luồng thay vì dựa vào cấu hình không được kế thừa từ tiến trình cha. Không đổi checkpoint hoặc ngưỡng để làm đẹp lượt xuất.

| Số đo lượt cuối | Kết quả |
|---|---|
| Nguồn / phát thực tế | 17,786 giây / 18,206 giây; 1× |
| Phản hồi trong thời gian phát | 22; tất cả có người hiển thị |
| Phản hồi mất toàn bộ bbox sau phát hiện đầu | 0 |
| Người hiển thị / mặt tối đa | 16–21 / 18; đây là số đầu ra, chưa có nhãn đếm đúng |
| Người có pose tối đa trong một phản hồi | 15 |
| Nhịp AI / P50 / P95 HTTP | 1,21 phản hồi/giây / 707 ms / 910 ms |
| Tổng bộ nhớ riêng các tiến trình AI cao nhất được lấy mẫu | 916,2 MB |
| Lỗi model / HTTP / JavaScript | 0 / 0 / 0 |
| Ghi hình / giải mã / phát Chrome | 547 khung, 1906×1080, 30 FPS, đã kiểm tra |
| Bbox trong 182 mẫu DOM thụ động | Nét liền, độ dày từ 4 px |

Video giữ nguyên độ khựng và trễ của giao diện; FPS mã hóa không phải FPS suy luận. Có đầu ra cảnh báo nhắm mắt/quay lệch và các bbox đồ vật cần người xem đối chiếu, chưa có nhãn chuẩn cho từng người/hành vi để đo precision/recall. Không khẳng định mọi bbox, ID, đồ vật hoặc cảnh báo đều đúng, hoặc mọi ca gục bàn đã được phát hiện. Chưa kiểm chứng trên camera/Pi thật. Dữ liệu gốc request, JPEG thực gửi và screencast ở `.qa/class_3-realtime-da_sua_2`.

Hồi quy: 157 kiểm thử Python, 72 backend, 141 frontend; TypeScript và build backend/frontend đạt. Kiểm thử model chuyển động nhanh kiểm tra đủ mặt/vị trí trên 140 ảnh thử có đối chứng hình học; ảnh thử không thay thế nhãn hành vi của video lớp học.

## Lượt class_3 trước khi sửa — giữ để đối chiếu

**Kết quả lớp đông chưa đạt.** `frontend/scripts/replay-camera-video.mjs` chạy duy nhất `backend/tests/videos/class_3.mp4` qua frontend sản phẩm, encoder, HTTP API và model backend hiện tại. Nguồn camera được thay bằng canvas stream từ MP4 phát một lần ở `playbackRate=1`; không sửa model/ngưỡng, không seek/tạm dừng giữa lúc phát, không dùng clock offline hoặc khóa serialize native. Đây là lần ghi headless Chrome có thêm tải ghi giao diện; không mở webcam/Pi thật.

Nguồn dài 17,786 giây; lần ghi thực tế 19,511 giây gồm trễ phát/ghi giao diện. Ban đầu có tối đa 16 mặt, nhưng từ **5,423 giây mất toàn bộ bbox và không nhận lại đến cuối**. Không có bbox thân hoặc cảnh báo hành vi trong lượt này. Có 71 phản hồi trong cửa sổ phát, trung bình 3,64 phản hồi/giây, P95 437 ms. Lượt dò mặt có lúc lên tới 6.343,62 ms; các trường lỗi model/HTTP/JavaScript vẫn rỗng. Vì vậy không thể dùng việc không có exception để kết luận pipeline đang quan sát tốt.

Video giữ nguyên hiện tượng tại `backend/tests/test_results/class_3_realtime.mp4`, đã giải mã đủ 586 khung 1906×1080 và kiểm tra phát bằng Chrome. MP4 30 FPS ghi lại màn hình theo thời gian thực, không đồng nghĩa AI chạy 30 lần/giây. Ảnh đầu/cuối và báo cáo cùng thư mục; dữ liệu request, JPEG thực sự gửi lên và screencast ở `.qa/class_3-realtime-after`. Video `class_3.mp4` xuất trước đó không bị ghi đè. Lượt này không can thiệp sửa backend; kết quả 140 khung có kiểm soát dưới đây chưa chứng minh khả năng chạy realtime ở lớp đông.

## Sửa rớt mặt khi nói chuyện hoặc chuyển động đầu nhanh — 13/11/2026

Luồng hiện tại chụp ảnh **sau khi xử lý khung trước**, qua encoder worker, không chụp sẵn ảnh lúc bắt đầu request trước. Cách chụp sẵn cũ làm ảnh tiếp theo chậm thêm một lượt inference. Ảnh dùng chụp mặt vẫn ghép đúng kết quả; camera hiển thị phát độc lập như mục đầu, bbox có thể trễ và tự hết hạn.

Tự giảm ảnh xuống 720p chỉ khi thấy rõ các **bbox mặt** đủ lớn. Bbox thân lớn không được dùng làm tiêu chí thay mặt. Khi mặt nhỏ hoặc mất mặt dù thân vẫn thấy, ảnh gửi lập tức trở lại độ phân giải nguồn đã cấu hình để tìm lại; bộ bám vẫn giữ ID khi kích thước JPEG thay đổi.

Trong cảnh tối đa tám mặt, mặt đã biết rộng từ 80 pixel trên ảnh gửi lên được dò YuNet trên ảnh hiện tại. Một mặt nhỏ ở nền không tắt nhánh nhanh của mặt lớn phía trước; mặt nhỏ tiếp tục dùng nhánh chi tiết/native. Nếu native tracker mất bám và không tìm được bằng lượt nhanh, tối đa bốn mặt được tìm lại trong vùng quanh đầu mở rộng bằng **SCRFD-500M pretrained đã có trong repo**. Các góc 0°/−30°/+30° được ghép thành một lượt model rồi chuyển tọa độ về ảnh gốc, để không bỏ dở hướng cần tìm khi hết ngân sách giữa các lượt dò. Mặt mới vẫn qua SCRFD-10G/landmark hiện có. Nhánh 500M chỉ dùng ngưỡng bám 0,60 cho một mặt đã xác minh trong 1,6 giây; không tạo ID mới hoặc gia hạn mốc xác minh. YuNet nhanh cần 0,85. Cả xác minh SCRFD và landmark/profile khớp ROI đều mở được đường phục hồi; timestamp landmark cache không được tự làm mới. Không cấp dữ liệu mắt/miệng hợp lệ chỉ từ kết quả bám mặt.

Các sửa liên quan: kết quả dò chậm không được ghi đè lần đo mới hơn; vị trí mặt đo trên khung hiện tại được ưu tiên hơn anchor thân đến chậm; hai template hội tụ cùng một mặt bị gộp để không tạo bbox trùng. Chuẩn bị template thân và chạy bù lịch sử chuyển sang worker nền với hàng đợi chỉ giữ việc mới nhất. Kết quả chuẩn bị bị hủy theo generation khi có lần quét xác nhận cảnh trống/đóng phiên; không trả lịch sử cũ sang người khác. Ngân sách dò phục hồi 85 ms được kiểm tra trước mỗi lần chạy model thêm; một inference đang chạy có thể khiến tổng thời gian vượt mốc này. Khi bằng chứng xác minh hết hạn thì nhánh nhanh ngừng, không dò liên tục trên vị trí cũ.

Kiểm chứng thật: 140 khung từ video nói chuyện công khai frontal/profile, thêm dịch đột ngột ±130 pixel và roll đến ±35°, cùng cảnh hai người di chuyển. Lượt trước sửa có 6 khung mất mặt; lượt mới nhất giữ đủ 140/140, không bbox trùng, mọi bbox khớp vùng tham chiếu đã biến đổi ở IoU tối thiểu 0,30. Đây là kiểm tra tương đối theo phép biến đổi và bbox tham chiếu, không phải độ chính xác trên lớp học được gán nhãn. P95 phản hồi ca chính diện chuyển động nhanh giảm 293 → 79 ms; ca nghiêng mặt chuyển động nhanh 250 → 177 ms; thời gian gặp lại mặt chuẩn sau ca nghiêng nhanh 1.609 → 100 ms. Các số này phụ thuộc máy/tải CPU và không phải cam kết FPS camera.

Chạy `npm --prefix backend run verify:fast-motion`. Ảnh thử, `baseline.json` và `after.json` ở `.qa/fast-motion`; không mở camera/Pi thật. Mất hẳn mặt/che kín vẫn trả thiếu dữ liệu mặt và tiếp tục theo dõi người, không dựng mặt hoặc cảnh báo nói chuyện từ vị trí cũ. Trọng số/cache/temp tiếp tục ở repo ổ D. CavT/SAV/SCB không bật.

Kiểm thử sau sửa: 72 backend TypeScript, 153 Python và 141 frontend; TypeScript/build đạt. Kiểm tra trình duyệt gồm webcam/Pi mô phỏng, tạm dừng/tắt và ảnh cảnh báo ghép đúng khung. Kiểm tra loại bbox ảo sau khi rời hình qua cả upload và API Pi-frame đạt. Bài đo 40 overlay đạt khi chạy riêng; lượt chạy đồng thời với benchmark AI từng xuống dưới 24 FPS, nên chưa khẳng định FPS giao diện lớp đông ở tải CPU cực đại. `AI_DEBUG_FACE_TRACKING=1` bổ sung tuổi xác minh/dò nhanh, confidence và dấu mất bám vào metrics để chẩn đoán, không ghi ảnh camera.

## Camera di chuyển, nhiều người và phục hồi nhận diện — 13/11/2026

Nhận diện chạy liên tục trong cùng phiên, không dừng sau khi tìm được mặt đầu tiên. Bộ tìm mặt tiếp tục quét khi đang bám mặt; người mới không phải chờ kết thúc phân tích hành vi của người trước. Khi không thấy mặt, luồng người/pose/đồ vật vẫn nhận ảnh. Tọa độ bbox chuẩn hóa theo ảnh hiện tại; hướng camera vẫn là hướng chuẩn của luật quay đầu, không phải hướng bảng trong không gian khi camera di chuyển.

Các lỗi đã sửa trong lượt rà này:

- Frontend tự đổi ảnh gửi 720p/1080p, nhưng ByteTrack trước đây giữ trạng thái pixel theo độ phân giải cũ. Nay bbox được đổi về mặt phẳng tọa độ đầu phiên trước khi cập nhật ByteTrack rồi đổi về ảnh hiện tại, giữ ID khi chỉ đổi kích thước ảnh.
- Ảnh cho bộ bám mặt trước đây đổi 640/960 theo số lượng/kích thước mặt, làm mất bộ bám và bỏ kết quả bất đồng bộ khi người thứ hai xuất hiện. Nay ảnh bám dùng cạnh dài tối đa 960 cố định; quét ô ảnh nhỏ cũng áp dụng cho ảnh dọc có cạnh dài trên 1280.
- Kết quả tìm người rỗng trước đây không có timestamp để phân biệt với chưa có kết quả, có thể để bbox bám nền đến hết hạn. Nay chuyển danh sách người và timestamp cùng một snapshot; một lần quét mới xác nhận không có người sẽ xóa bộ bám người.
- Lịch sử 32 khung quá ngắn để ghép kết quả người chậm trên luồng nhanh. Nay giữ tối đa 128 khung trong 3,5 giây. Kết quả đã cũ hơn cửa sổ vẫn bị loại. Không khởi tạo lại template và chạy lại lịch sử mỗi lần YOLO xác nhận vị trí đang bám: chỉ làm khi mất bám, sai khác rõ hoặc template đến hạn làm mới.
- Một lỗi khung HTTP 408/422/429/500 trước đây khiến frontend tạm dừng ngay. Nay thử lại tối đa hai lần, sau 250/500 ms; thành công thì tiếp tục. Ba lần lỗi liên tiếp sẽ tạm dừng và báo lỗi. Mất backend/phiên vẫn cần bấm **Tiếp tục nhận diện** để tạo lại phiên. Backend ghi log cả lỗi/phục hồi luồng người và pose, ngoài mặt/hành vi/đồ vật.

**Tạm dừng nhận diện** hủy lịch gửi khung tiếp theo, bỏ kết quả trả muộn và giữ video/danh sách ảnh. Một yêu cầu đang xử lý có thể hoàn tất ở backend; khi tiếp tục, frontend chờ yêu cầu cũ xong trước khi gửi mới. **Tắt camera** hủy lịch, dừng media track, giải phóng detector/phiên và xóa dữ liệu hiển thị. Không dỡ toàn bộ model dùng chung khỏi backend chỉ vì đóng một phiên.

Kiểm chứng dùng model backend thật với ảnh fixture phát theo thời gian thực: một người, người thứ hai đi vào, đổi luân phiên 720p/1080p giữ ID hai người, dịch camera trái/phải/lên/xuống, cảnh trống, hai người trở lại, JPEG hỏng rồi tiếp tục và kết thúc/tạo phiên mới. Báo cáo `.qa/camera-recovery/report.json`: tất cả qua; lượt sau sửa chuyển động nhanh có P95 phản hồi 138 ms, bộ nhớ private cực đại của worker và các tiến trình con 962,3 MB (lượt trước: 244 ms/921 MB). Đây là tải ảnh thử 1–2 người, không phải FPS camera hay cam kết độ chính xác lớp đông/người bị che chéo. Không thực hiện mở camera hoặc điều khiển Pi thật. ID theo dõi có thể đổi sau khi mất hẳn đối tượng; không phải nhận dạng danh tính sinh trắc học. Mặt quay lưng/che kín không được dựng thành mặt nhìn thấy.

Chạy lại bằng `npm --prefix backend run verify:camera-recovery`. Kiểm tra Python có 140 test; frontend có thêm kiểm tra tự thử lại có giới hạn và hủy thử lại khi tạm dừng. `npm --prefix frontend run test:system` kiểm tra HTTP, nhận diện liên tục, tạm dừng/tiếp tục, kết quả muộn khi reset/tắt, nhiều bbox và webcam/Pi mô phỏng trên trình duyệt.

## Danh sách mặt cần chú ý thay sơ đồ lớp

Sơ đồ vị trí/bảng/điểm học sinh đã bỏ khỏi giao diện. Cột **Cần chú ý** hiển thị từng người có cảnh báo: ảnh mặt, mã/tên có thể sửa, dấu hiệu đã ghi nhận, thời điểm, số lần ghi nhận và trạng thái đang cảnh báo/đã ghi nhận. Người chỉ đang được quan sát không tạo mục ảnh cảnh báo. Duy trì một mục mới nhất cho mỗi mã/người, tối đa 40 mục; cảnh báo liên tục không chụp lại hoặc tăng số lần mỗi khung. Danh sách cập nhật khi có cảnh báo mới hoặc đổi nhóm dấu hiệu.

`AttentionCaptures` trong frontend nhận track sau bước `detector.paintFrame` và cắt JPEG 160×160 từ **canvas khung đã phân tích**, dùng `faceBox` gốc (`box` chỉ khi `boxKind=face`). Không dùng `displayBoxes`, video live, bbox thân, track đã mất hoặc ROI suy đoán để cắt mặt. Crop có lề 20%, giữ tỷ lệ vuông và giới hạn trong ảnh. Trường hợp detector không có ảnh đã phân tích để vẽ thì vẫn ghi nhận thông tin nhưng không chụp từ nguồn không đồng bộ.

Mặt quan sát bình thường được giữ một thumbnail mới tối đa mỗi giây để phục vụ lần khuất ngắn, tuổi tối đa 2 giây. Khi cảnh báo xảy ra mà mặt đang khuất, chỉ dùng thumbnail cùng person ID hoặc ảnh của lần cảnh báo trước cùng người và ghi **Ảnh mặt trước cảnh báo** kèm giờ. Nếu chưa có ảnh phù hợp thì hiển thị **Chưa chụp được mặt**; có thể bổ sung khi mặt trở lại trong cảnh báo. Đổi person ID cùng mã chữ không kế thừa ảnh/lịch sử.

Ảnh chỉ nằm trong bộ nhớ trình duyệt trong phiên, không ghi file/localStorage và không gửi thêm lên backend. **Tạm dừng nhận diện** giữ ảnh để xem. **Xóa danh sách cần chú ý** xóa ảnh/mục mà không dừng camera hoặc tạo lại ngay cảnh báo liên tục vừa xóa. **Đặt lại phiên nhận diện**, tắt/đổi camera, tạo lại phiên khi lỗi backend hoặc thay generation Pi xóa bộ nhớ ảnh. Backend và giao thức Pi giữ nguyên, tính năng này dùng chung cho webcam/Pi.

Kiểm chứng: 135 frontend tests đạt, TypeScript/build đạt; Chrome production app + HTTP evaluator với ảnh video có sẵn và số đo điều khiển, không mở webcam hoặc gửi lệnh Pi thật. Kiểm tra crop khớp canvas, hai ảnh mặt và một trường hợp thiếu mặt, đổi tên, phóng to, tạm dừng, xóa riêng danh sách, cảnh báo mới, dừng camera và desktop/mobile. Chạy `npm --prefix frontend run test:captures` sau build; báo cáo và ảnh ở `.qa/attention-captures`. Đây là kiểm tra chụp/hiển thị, không phải độ chính xác model hành vi. Các số đo sơ đồ ở phần lịch sử không còn mô tả giao diện hiện tại.

## Tùy chỉnh ngưỡng trên giao diện

Nút **Ngưỡng nhận diện** cạnh các nút camera mở cấu hình cho cả 11 dấu hiệu: bật/tắt cảnh báo, thời gian xác nhận; các mục liên quan có thêm góc cúi/quay, số lần đổi hướng và cửa sổ đếm, chu kỳ miệng, điểm cười, tỷ lệ vai/thân, góc/chiều cao gục và điểm model gục bàn. Nhập thời gian theo giây, góc theo độ, điểm/tỷ lệ theo phần trăm. Mỗi trường có giới hạn hợp lệ do backend cung cấp. Nhánh quay đầu qua lại dùng số lần trong cửa sổ thời gian, không có thời gian giữ hướng riêng.

Bảng hiện dùng **mỗi dấu hiệu một hàng**, đánh dấu `*` đỏ ở tên bật/tắt và các trường có thể chỉnh; mô tả đầy đủ trong tooltip của tên. Các tham số nằm cùng hàng, kéo ngang trong vùng tham số trên màn hình hẹp. Dấu `*` là ký hiệu có thể chỉnh, không phải trường bắt buộc hoặc đánh dấu đã thay đổi.

**Lưu ngưỡng** lưu vào trình duyệt hiện tại và áp dụng trước khung nhận diện tiếp theo, cho cả webcam/Pi. Camera không phải dừng hoặc khởi động lại backend. Đổi cấu hình xóa bộ đếm/cảnh báo hành vi cũ, giữ mã người và bbox; các phiên khác không bị đổi. Đổi nguồn hoặc tạo lại phiên vẫn gửi cấu hình đã lưu. **Mặc định** chỉ điền lại bản nháp, cần bấm Lưu ngưỡng để áp dụng. Đóng bảng không lưu các thay đổi chưa lưu. Khi backend chưa kết nối, có thể tải lại cấu hình trong bảng.

Các tham số này điều chỉnh **luật xác nhận cảnh báo** trên số đo model; không thay confidence phát hiện người/mặt/đồ vật của Python. Riêng điểm phụ trợ gục bàn có thể tăng từ 25% trở lên; không cho giảm dưới sàn 25% của nhánh model. Tắt cảnh báo không dừng model hoặc xóa bbox. Điều kiện mẫu mới, chống nhầm cười/ngáp thành nói, không gán lịch sử cho người khác vẫn giữ; không coi chỉnh ngưỡng là bảo đảm tăng độ chính xác.

Backend cung cấp schema/mặc định tại `GET /api/observation-settings`. `POST /api/sessions` nhận JSON tùy chọn `{settings}`; `GET/PUT /api/sessions/:id/settings` đọc/thay toàn bộ cấu hình phiên. Payload đầy đủ gồm `enabled` và `thresholds`; từ chối tên lạ, thiếu trường, sai kiểu, số không hữu hạn, ngoài khoảng hoặc không nguyên. Thời gian trong API dùng mili giây. PUT khi phiên đang xử lý khung hình trả 409; frontend gửi tuần tự trước lần detect kế tiếp. Khóa lưu trình duyệt: `student-attention.observation-settings.v1`.

Kiểm tra thực tế giao diện/HTTP: sau `npm run build`, chạy `npm --prefix frontend run test:settings`. Script dùng Chrome, camera canvas và số đo điều khiển được để kiểm tra áp dụng khi chạy, giữ ID, tắt cảnh báo, dữ liệu sai, lưu qua reload, khôi phục và bố cục 1440/1024/768/390 px. Đây là kiểm tra cấu hình, không phải kiểm tra độ chính xác model. Bằng chứng ở `.qa/detection-settings/report.json`, `desktop.png`, `mobile.png`.

## Ngưỡng mặc định

| Dấu hiệu | Điều kiện thời gian tối thiểu |
|---|---|
| Nhắm mắt | 0,8 giây |
| Cầm điện thoại | 0,4 giây |
| Cúi đầu | 0,7 giây; vào từ pitch 18°, giữ từ 16° |
| Có thể ngáp | 0,5 giây |
| Có thể nói chuyện kéo dài | 2,5 giây và ít nhất 4 chu kỳ miệng, có chu kỳ hoàn tất còn mới |
| Tương tác laptop | 0,7 giây |
| Quay đầu qua lại nhiều lần | 3 lần đổi hướng rõ trong cửa sổ 10 giây |
| Quay lệch hướng lâu | Lệch hướng camera từ 25° trong 2 giây; về trong 15° liên tục 0,6 giây để kết thúc |
| Có dấu hiệu quay thân sang bên | Thay đổi hình học thân phù hợp và đầu quay lệch, duy trì 2 giây |
| Quay sang bên kèm cười | Đang quay lệch đã xác nhận và hai khóe miệng từ 0,55 trong 0,5 giây |
| Có dấu hiệu gục đầu/thân trên | Pose thân hạ/gập hoặc bằng chứng gục bàn được đối chiếu với người, duy trì 1,5 giây |

## Hướng chuẩn và tư thế — bản nâng cấp 13/11/2026

Hiện có **11 kênh quan sát**. Theo yêu cầu mới, lấy hướng camera làm chuẩn ngay, bỏ thu mẫu cá nhân trong 10–20 giây. `AI_CAMERA_YAW_DEG=0` mặc định là nhìn về camera; có thể đặt góc bù cố định cho camera chéo. Không tự học lại từ hướng học sinh đang quay. Hướng camera không chứng minh học sinh đang nhìn bảng; đây là giới hạn của cấu hình này. Các thời gian xác nhận hành vi vẫn giữ để tránh cảnh báo từ một khung hình.

Trường `calibration` được giữ tương thích API, hiện trả `state: ready`, `reference: camera`, `headingReady: true`, `postureReady: true` ngay. Các cờ này cho biết đã có quy tắc tham chiếu, không khẳng định có số đo pose/mặt; tín hiệu thiếu số đo vẫn là `unavailable`. Không còn nhãn đang lấy hướng chuẩn trong phản hồi mới. Đổi người/phiên xóa lịch sử hành vi. Chuyển endpoint upload/Pi trong cùng HTTP session tạo ngữ cảnh AI nội bộ mới; frontend cũng tạo lại session khi đổi camera máy tính.

`head_turned` không cần quay nhiều lần. `torso_turned` cần hai vai và cặp hông/khuỷu tay có độ tin cậy, tỷ lệ vai/thân nhỏ hơn mốc hình học chính diện ít nhất 25%, hướng đầu lệch và thân không chỉ nghiêng ngang. Mốc vai/thân là 1 khi dùng hông, 2 khi dùng khuỷu tay. Hình học được chuẩn hóa theo tỷ lệ ảnh; đây là quy tắc ảnh 2D, không phải góc xoay thân 3D đã hiệu chuẩn. Che khuất/nhập nhằng trả `unavailable`.

`turned_smiling` chỉ kết hợp cười với quay lệch đã xác nhận. Cười chính diện không tạo cảnh báo này; nụ cười không được diễn giải thành ý định đùa giỡn và vẫn bị loại khỏi bộ đếm nói chuyện.

`upper_body_slumped` ưu tiên YOLO pose, không cần thấy mặt. Dùng hai vai–hai hông; khi hông khuất, dùng hai khuỷu tay ổn định qua ít nhất ba mẫu/0,6 giây. Chiều cao thân/độ rộng vai được so với mốc 1 (hông) hoặc 0,5 (khuỷu tay): hạ rõ khi còn tối đa 65% mốc, nghiêng rõ khi trục thân từ 40°. Cần thêm đầu gần/thấp hơn vai, hoặc đồng thời hạ và nghiêng rõ nếu không thấy đầu. Cúi đầu đọc khi thân thẳng và mất mặt riêng lẻ không đủ để xác nhận gục. Có sách/vở không phủ quyết tư thế gục đã xác nhận.

Trường hợp đầu nằm trên bàn trong `class_2.mp4` không có keypoint pose và YOLO người cho điểm thấp. Bổ sung checkpoint YOLOv8n lớp học được ghim nguồn/checksum tại `backend/ai/desk_rest_model.json`, chỉ dùng lớp `Sleeping` làm **bằng chứng tư thế gục bàn**, không khẳng định đang ngủ. Cần điểm từ 0,25, cao hơn các lớp khác ít nhất 0,05; đối chiếu một–một với bbox người YOLO11s có tỷ lệ rộng/cao từ 1,1 và IoU từ 0,45. Bbox đầu của người đang đọc nhưng thân còn thẳng không đủ. Pose xác nhận thân thẳng phủ quyết nhánh ảnh này.

Người mới vẫn cần điểm YOLO11s từ 0,1 và đồng thuận hai model trước khi được nâng điểm cho ByteTrack. Candidate từ 0,03 chỉ được nối ngắn khi khớp một người đã được đối chiếu trong 2 giây gần nhất; không tự tạo người, không làm mới timestamp xác nhận người gốc. Node cũng kiểm tra tuổi xác nhận người. Các ngưỡng ByteTrack thông thường giữ 0,2/0,1. Dấu hiệu gục vẫn phải kéo dài ít nhất 1,5 giây với mẫu mới. `observation.deskRest` mang điểm hai nguồn, timestamp tư thế và timestamp xác nhận người. Model bổ sung nằm trong `backend/models/classroom`, cache/temp trong repo; không bật CavT, SAV hoặc SCB thử nghiệm.

Các trường mới: `observation.bodyPose` chứa 17 keypoint `{x,y,confidence}`, bbox pose, confidence, `aspectRatio`, `observedAt`, nguồn `YOLO11n-pose`; bốn loại tín hiệu mới trong `signals`/`alerts` là `head_turned`, `torso_turned`, `turned_smiling`, `upper_body_slumped`. Endpoint và hai trạng thái màu được giữ nguyên. Cảnh báo gục và quay kèm cười được ưu tiên hiển thị khi đồng thời có nhiều dấu hiệu.

Nhánh pose có mailbox và luồng riêng, nhận ảnh trước bước tìm mặt; sau tìm mặt chỉ làm mới dữ liệu quan sát, không sửa lại bbox từ snapshot cũ. Pose ghép một–một theo ID người trên dữ liệu nguồn phù hợp, không gán khi điểm ghép gần nhau. Khi chưa có metadata người cho ảnh pose, chỉ giữ số đo đã gán trước đó trong giới hạn mới 2 giây và giữ nguyên timestamp. Nhánh đồ vật chỉ được dùng cổ tay từ ảnh pose cùng thời điểm hoặc trước ảnh nguồn, không lấy keypoint tương lai.

Mỗi dấu hiệu có bộ đếm riêng theo người. Các thời gian trên là ngưỡng tối thiểu; độ trễ thực còn phụ thuộc nhịp model và máy. Mắt/đồ vật vẫn cần ít nhất hai số đo mới. Timestamp lặp không tăng thời lượng hoặc gia hạn cảnh báo. Các điều kiện chống nhầm nháy mắt một bên, ngáp thành nói chuyện, và gán đồ vật cho hai người vẫn giữ. Hạ ngưỡng tăng độ nhạy, chưa chứng minh tăng độ chính xác trên lớp thật.

Ngưỡng kích thước mặt cho hành vi mặc định giảm từ 48 xuống 40 px; Face Landmarker detection/presence từ 0,35/0,5 xuống 0,3/0,45; tay từ 0,4/0,4 xuống 0,35/0,35; confidence đồ vật từ 0,25 xuống 0,2; pose từ 0,3 xuống 0,25. ByteTrack bắt đầu track người từ 0,2 thay cho 0,25. Không hạ các bộ lọc chống nhầm tai/đầu thành khuôn mặt. `MIN_BEHAVIOR_FACE_PX` trong cấu hình riêng vẫn được tôn trọng.

## Giảm cảnh báo nói chuyện nhầm và tương thích Pi

Đã sửa khả năng chu kỳ miệng cũ tiếp tục gia hạn cảnh báo: mỗi chu kỳ giữ cặp thời điểm bắt đầu/kết thúc; tín hiệu chỉ xác nhận khi chu kỳ cuối hoàn tất trong 450 ms gần nhất. `talking.observedAt` lấy thời điểm **kết thúc chu kỳ**, không lấy timestamp của mẫu mặt đứng yên sau đó. Vì vậy mẫu mới nhưng không có chu kỳ mới không gia hạn cảnh báo. Cửa sổ chu kỳ mặc định 5 giây, tăng thành ít nhất `talkingMs + 2 giây` nếu người dùng đặt thời gian dài hơn; chu kỳ hết hạn không được kéo dài duration bằng mốc đầu cũ.

Biên độ miệng tối thiểu tăng từ 0,035 lên 0,06, jawOpen từ 0,06 lên 0,10; hai kênh vẫn độc lập và không cộng chu kỳ. Nhánh nói chuyện cần mặt từ 64 px và ảnh được đánh giá đủ rõ; các kênh đầu/mắt khác giữ quy tắc riêng. Thay đổi yaw/pitch trên 8° giữa hai mẫu cách tối đa 750 ms xóa chu kỳ nói, không kết luận chuyển động đầu là nói. Chặn cười khi trung bình điểm hai bên từ 0,45 và bên thấp hơn từ 0,3; ngáp vẫn xóa chu kỳ. Profile ổn định còn đủ điểm môi vẫn được xét; mất dữ liệu hoặc đổi nguồn landmark không được cộng chu kỳ qua nguồn.

Mặc định mới: **2,5 giây và 4 chu kỳ**. Cấu hình đã lưu trên trình duyệt không bị ghi đè: muốn dùng mốc này, chỉnh riêng hàng nói chuyện thành 2,5 giây/4 chu kỳ rồi Lưu ngưỡng. `Mặc định` + Lưu đưa toàn bộ dấu hiệu về mặc định. Giữ cảnh báo đã xác nhận 5 giây vẫn áp dụng; nụ cười/không còn chuyển động không có nghĩa cảnh báo cũ biến mất ngay. Đây là dấu hiệu từ ảnh, không có âm thanh và chưa chứng minh loại hết nói nhầm/nhép miệng/nhai.

Đối chiếu mã Pi hiện có: `Raspberry_pi_4/agent.py` chỉ phát video H.264 qua MediaMTX/RTSP TCP, 1280×720, mặc định 15 FPS. Backend `pi_stream.py` giải mã, mã hóa JPEG và gửi gói độ dài big-endian 4 byte + JPEG cho `PiController`/`PiSource`. Web chụp ảnh Pi đang hiển thị để gọi `/detect`, hoặc dùng `/detect/pi` khi không có ảnh; cả hai đi qua `Sessions`, Python model và `AttentionEvaluator`, dùng cùng cấu hình phiên và `displayBoxes`/`displayBox`. Agent không chứa model/luật nói chuyện hoặc schema ngưỡng, nên sửa luật này không đòi cập nhật agent.

Kiểm chứng: 13 kiểm thử agent Pi, kiểm thử HTTP `pi-observation-compatibility.test.ts` (1280×720, token, hai nguồn, tùy chỉnh/tắt cảnh báo, bbox hiển thị, mất nguồn), `speech-stability.test.ts` (nhiễu, cười/ngáp/quay đầu, chu kỳ cũ, timestamp lặp, profile ổn định, thời gian tùy chỉnh trên 5 giây). Phát lại 509 số đo model từ video nói có sẵn vẫn có 156 mẫu đạt điều kiện, đối chứng mặt đứng yên 0; profile ngắn 33 mẫu chưa đủ thời gian xác nhận. Không dùng các số này làm precision/recall vì không có nhãn hành động. Báo cáo ở `.qa/speech-review` và ảnh giao diện ở `.qa/detection-settings`. Chưa truy cập/triển khai hoặc đo trực tiếp Pi vật lý trong lượt sửa này; chỉ xác nhận hợp đồng mã nguồn/giao thức và kiểm thử, không xác nhận phiên bản đang cài trên thiết bị.

## Quay đầu và mất mặt

Ưu tiên yaw có dấu từ face pose, sau đó nhánh profile đã kiểm chứng, hoặc hướng ước lượng từ mũi và cặp tai/mắt của YOLO11n-pose. Hướng từ keypoint là đại lượng tương đối, không phải số đo góc đã hiệu chuẩn. Không dùng độ dịch chuyển bbox người để giả hướng đầu.

Với face pose, vùng hướng trái/phải bắt đầu khoảng ±20°, vùng chính diện khoảng ±11°; giữa các vùng có khoảng đệm chống rung. Mỗi vùng mới cần hai mẫu riêng trải ít nhất 120 ms; các lần đổi hướng cách nhau ít nhất 250 ms. Chuyển giữa trái/phải/chính diện được tính là đổi hướng. Đổi nguồn đo không được tự tính là chuyển động.

Lịch sử gắn với track người và được giữ qua lần thiếu số đo hướng đầu tối đa 3 giây. Khi mặt biến mất nhưng còn thân người, pipeline vẫn theo dõi người và đồ vật; pose đầu được lấy tối đa khoảng mỗi 400 ms, không cần chờ model mặt. Nếu các keypoint đầu cũng thiếu, `head_turning` trả `unavailable`, không tự tăng số lần quay. Mắt/miệng không nhìn thấy cũng trả `unavailable`. Cảnh báo đã xác nhận giữ 5 giây trên cả bbox người và sơ đồ.

Ghép pose đầu–người là một–một; trường hợp chồng lấn có điểm ghép gần nhau không được gán hướng đầu. Khi mặt xuất hiện lại với geometry ID mới nhưng cùng person ID, lịch sử được tiếp tục. Người khác hoặc phiên mới không được kế thừa lịch sử cũ. Nếu cả người và mặt đều mất, track chỉ giữ tạm 3 giây để tìm lại; hệ thống không cam kết theo dõi một người đã khuất hoàn toàn.

## Kiểm tra

### Ổn định bbox và vị trí nhãn

Backend thêm bộ lọc hiển thị riêng theo phiên/mã người, mặt và đồ vật. `box`, `personBox`, `faceBox` gốc vẫn dùng để ghép ID, tính tư thế, tương tác và cảnh báo. API bổ sung `displayBoxes: {box?, person?, face?}` trên người và `displayBox` trên đồ vật; frontend kiểm tra tọa độ và dùng các trường này để vẽ. Không có nội suy/dự đoán vị trí giữa hai ảnh đã phân tích.

Vị trí được lọc theo thời gian khoảng 110 ms cho dao động nhỏ, phản ứng nhanh khoảng 28 ms khi có dịch chuyển rõ. Kích thước có hằng số thời gian 210 ms và bị giới hạn sai khác tối đa 12% so với kích thước đo hiện tại. Đây là tham số lọc, không phải độ trễ cam kết của toàn pipeline. Nhảy xa/đổi cỡ rất lớn, khoảng trống trên 750 ms, đổi người hoặc đổi nguồn đặt lại bộ lọc. Khi mặt/người/đồ vật không còn được trả về, bộ lọc không dựng hoặc giữ thêm bbox; không dùng nó để thay bằng chứng phát hiện.

Nhãn giữ vị trí tương đối cũ qua dao động và va chạm nhỏ; chỉ bố trí lại khi cản trở rõ hoặc va chạm kéo dài. Bộ nhớ nhãn gắn với ID/viewport, xóa khi mất đối tượng hoặc đổi camera. Công cụ xuất giữ bộ nhớ này qua mỗi lần tái tạo Chromium, tránh nhảy nhãn định kỳ tại khung 101/201/301/401. Bbox nét liền 4 px, nhãn đỏ/vàng và chữ trắng 16 px được giữ.

Theo yêu cầu bố cục mới, nhãn người ở **phía trên đầu**, căn theo bbox mặt khi thấy mặt và theo bbox người khi mặt khuất, ưu tiên căn giữa với khoảng cách 8 px. Khi chật chỉ dịch ngang ít hoặc xếp cao thêm tối đa 64 px, không chuyển sang bên hông/dưới người hoặc trôi xa lên trần ảnh. Vị trí vẫn được giữ qua dao động nhỏ. Nếu sát mép trên, nhãn được giữ trong ảnh. Khi có bbox người, bỏ ô mã nhỏ lặp trên mặt; mã và cảnh báo đã nằm trong nhãn phía trên. Trình xuất kiểm tra cả vị trí phía trên và giới hạn khoảng cách tại 450 khung, ghi `aboveHeadLabelsVerified` trong `summary.json`. Số đo nhảy nhãn bên dưới thuộc lượt ổn định trước thay đổi bố cục; bằng chứng tương ứng được giữ ở `.qa/bbox-stability/labels-before-above-head.jsonl` và `stability-before-above-head.json`.

Lượt model thật trên `class_2.mp4` gồm 450 khung, 1906×1080, 30 FPS; video ghi đè tại `backend/tests/test_results/class_2.mp4`. Đối chiếu tọa độ gốc và tọa độ hiển thị trên cùng khung, chỉ tính các cặp liên tiếp cùng mã:

| Loại bbox | Biến thiên kích thước P95 trước lọc | Sau lọc |
|---|---:|---:|
| Người | 11,765% | 1,572% |
| Mặt | 6,250% | 1,119% |
| Đồ vật | 11,111% | 1,395% |

Nhãn người: số bước nhảy trên 40 px giảm từ 1.168 (bố trí độc lập mỗi khung trên bbox gốc) xuống 24 (giữ vị trí trên bbox hiển thị), trên 8.301 cặp liên tiếp. Đây là độ ổn định hình vẽ, không phải độ chính xác nhận diện. Nhận lại đối tượng/chuyển động lớn vẫn có thể tạo bước nhảy. Không ghi nhận lỗi pipeline, bộ nhớ riêng worker báo cáo đỉnh 968 MB; lượt suy luận offline 162,8 giây, không dùng làm FPS camera thực tế. Kiểm tra đạt 60 backend, 136 Python, 125 frontend, TypeScript và build. Chromium xác nhận bbox khớp các trường hiển thị API, nét/chữ/màu đúng và MP4 phát được. Bằng chứng ở `.qa/class_2-stable/stability-report.json`, `class_2_label_positions.jsonl`, `summary.json`; ảnh khung 68–73 trước/sau tại `.qa/bbox-stability`.

### Đối chiếu bản hướng camera trên `class_2.mp4`

Đã chạy lại 450 khung hình gốc (15 giây, 1906×1080, 30 FPS) bằng backend production và xuất overlay từ component React/CSS thật. Không có lượt chờ hiệu chuẩn. Người nằm đầu xuống bàn bắt đầu có cảnh báo `upper_body_slumped` ở khoảng 3,93 giây, có cảnh báo tại khung 150/225/300/450; giữ cùng mã R trong các khung đối chiếu. Hai trường hợp cúi đọc phía trước trái và ngồi thẳng giữa không có cảnh báo gục trong cả clip. Người phía sau thiếu pose nên vẫn trả `unavailable`, không coi là đã xác nhận tư thế bình thường.

Vẫn có 48/450 khung không ghép được bbox đang thấy vào vùng người gục (bao gồm lúc khởi động), tương đương khoảng 1,6 giây cộng dồn; đây vẫn là giới hạn theo dõi. Số khung này giảm so với 112 khung của lượt đầu bổ sung model. Vùng đối chiếu chỉ nằm trong script QA, không dùng để tạo phát hiện ở backend. Kết quả là kiểm tra trường hợp cụ thể, không phải điểm chính xác chung hay bằng chứng người đó ngủ.

450 khung suy luận hoàn tất trong 159,5 giây trên CPU, không ghi nhận lỗi pipeline/cấp phát; đỉnh bộ nhớ riêng **worker được báo cáo** là 974 MB (không phải số đo toàn cây tiến trình). Đây là lượt xuất offline có tuần tự hóa native để hạn chế đỉnh RAM, không phải cam kết FPS camera thời gian thực. Kiểm thử: 30 backend, 136 Python, 118 frontend; TypeScript và build đạt. Bằng chứng: `.qa/class_2-camera-final/case-review.json`, `class_2_inference.json`, `class_2_predictions.jsonl`. Video được ghi đè tại `backend/tests/test_results/class_2.mp4`, bbox người/mặt riêng và nét liền.

Giao diện video được cập nhật tiếp: bbox người/mặt/đồ vật dày 4 px, nhãn chữ trắng đậm 16 px. Cảnh báo có nền đỏ, tiêu đề `CẦN CHÚ Ý` và tên dấu hiệu đầy đủ; trạng thái quan sát có nền vàng. Nhãn ưu tiên cảnh báo, tránh vùng đầu đã nhận diện và các nhãn đã đặt; nhãn người đặt phía trên, khi xếp cao có đường nối về bbox. Khi có bbox người, mặt chỉ vẽ khung để hạn chế nhãn lặp. Lượt xuất lại phần hiển thị dùng đúng 450 kết quả backend đã lưu, không đổi model hoặc ngưỡng.

### Lệnh kiểm tra

```powershell
npm --prefix backend test
npm --prefix frontend test
npm run typecheck
npm run build
npm run verify:model
npm run verify:observations
```

`verify:observations` chạy model thật qua HTTP trên ảnh chân dung công khai lặp 30 giây và một lượt đoạn lớp học `class_6.mp4` dài 10 giây theo FPS nguồn; cần bộ ảnh nguồn đã có tại `.qa/video-export-ui/class_6_input_frames`. Lệnh không mở webcam/Pi, không tải model hoặc dữ liệu. Báo cáo ở `.qa/observation-upgrade/runtime.json` gồm độ trễ, bộ nhớ, độ phủ pose còn mới và độ phủ tham chiếu. Ngưỡng vận hành là không lỗi pipeline, có người/pose, P95 không quá 2,5 giây và bộ nhớ riêng toàn cây AI không quá 2 GB; không dùng các ngưỡng này làm độ chính xác hành vi.

Đối chiếu bbox bằng component production trên Chrome: từ `frontend`, chạy `node scripts/check-person-overlay.mjs --observations` và thêm `--single` cho ảnh một người. Ảnh đối chiếu và JSON được lưu trong `.qa/observation-upgrade`; tất cả cache/temp của bài kiểm tra nằm trong repo.

Kiểm thử quy tắc ở `backend/tests/observation.test.ts`; keypoint và ghép người ở `backend/ai/test_head_orientation.py`, `backend/ai/test_perception.py`, `backend/ai/test_person_tracking.py`. Kiểm tra API/giao diện gồm cảnh báo quay đầu khi không thấy mặt. `verify:model` dùng ảnh có sẵn và các model thật, không mở webcam/Pi; đây là smoke test, không đo độ chính xác quay đầu trên video lớp có nhãn.

Lịch sử trước bản nâng cấp: lượt kiểm tra chỉ có bảy kênh từng gặp lỗi cấp phát bộ nhớ trong sandbox. Lượt ngày 13/11/2026 đã chạy qua smoke test model thật với 11 kênh, pose 17 điểm và CavT tắt. Các phép đo runtime bên dưới thuộc bản hiệu chuẩn cá nhân trước thay đổi hướng camera/model gục bàn; không dùng chúng làm số đo hiệu năng của bản mới, hoặc dùng unit test để công bố độ chính xác hành vi trên toàn lớp.

### Số đo lịch sử trước khi chuyển sang hướng camera

Lượt cuối qua HTTP, hai trường hợp chạy nối tiếp trong cùng một cây AI; không mở camera vật lý:

| Nguồn | Số lượt API | Số người tối đa | P95 API | Bộ nhớ riêng đỉnh | Độ phủ pose còn mới |
|---|---:|---:|---:|---:|---:|
| Ảnh chân dung công khai, suy luận lặp 30,2 giây | 135 | 1 | 267 ms | 920,2 MB | 97,78% |
| Video lớp học 10,1 giây, một lượt theo đồng hồ nguồn | 17 | 25 | 1.240 ms | 986,1 MB | 29,27% |

Không ghi nhận lỗi pipeline/cấp phát bộ nhớ, cả hai trường hợp qua ngưỡng vận hành của script. Độ phủ tính trên mọi lượt người được trả là đang thấy, chỉ tính pose có timestamp không quá 2 giây ở thời điểm nhận HTTP. Đây không phải phần trăm nhận diện hành vi đúng. Ở cảnh lớp đông chỉ 23,00% lượt có đủ cặp vai và hông/khuỷu tay cho phép phân tích thân trên; các lượt thiếu dữ liệu không bị coi là đã xác nhận không có hành vi.

Ảnh một người lấy được hướng chuẩn/tham chiếu thân; độ phủ tham chiếu trong cả lượt gồm thời gian hiệu chuẩn là 68,15%/62,22%. Đoạn lớp học chỉ dài 10 giây và còn thời gian khởi động nên chưa có tham chiếu đạt điều kiện trải đủ 10 giây; không kết luận quay lệch theo hướng chuẩn đã hoạt động đầy đủ cho 25 người. Cần video lớp dài hơn, có nhãn và kiểm chứng camera thật để đánh giá độ phủ hiệu chuẩn, precision/recall và cảnh gục thực tế. Bản này đã chạy được pipeline pretrained, chưa phải xác nhận đạt độ chính xác hành vi trên toàn lớp.

Chrome dùng component production và phản hồi HTTP mới: ảnh một người có một bbox người và một bbox mặt riêng, tọa độ khớp API; ảnh lớp cuối có 19 bbox người khi cả 19 mặt không khả dụng, không vẽ mặt cũ. Hai bài đối chiếu đều đạt. Bằng chứng: `.qa/observation-upgrade/runtime.json`, `single-overlay-check.json`, `overlay-check.json`, `single-person-overlay.png`, `person-overlay.png`.
