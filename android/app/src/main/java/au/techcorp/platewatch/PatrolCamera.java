package au.techcorp.platewatch;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.MeteringRectangle;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.SystemClock;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import androidx.annotation.OptIn;
import androidx.camera.camera2.interop.Camera2CameraControl;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.CaptureRequestOptions;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import androidx.camera.core.*;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.*;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.File;
import java.io.FileOutputStream;
import java.util.*;

@CapacitorPlugin(name="PatrolCamera")
public class PatrolCamera extends Plugin {
    private FrameLayout panel;
    private ProcessCameraProvider provider;
    private TextRecognizer reader;
    private ToneGenerator tone;
    private String session;
    private final Map<String,Long> lastSeen = new HashMap<>();
    private final Set<String> emitted = new HashSet<>();

    /* Zoom lets an officer read a plate from the footpath or the vehicle instead of stepping
       in front of the car. Presets and the starting zoom come from the web layer (src/lib/zoom.ts). */
    private static final float MAX_ZOOM = 10f;
    private static final int SLIDER_STEPS = 1000;
    private Camera camera;
    private View guide;
    private LinearLayout sliderRow;
    private SeekBar slider;
    private TextView zoomLabel;
    private final List<Button> presetButtons = new ArrayList<>();
    private final List<Float> presets = new ArrayList<>();
    private float zoomMin = 1f, zoomMax = 1f, initialZoom = 1f;
    private boolean zoomReady;

    @PluginMethod public void start(PluginCall call) {
        // CameraX needs the runtime permission; the WebView camera normally obtains it first,
        // but fail clearly rather than with an opaque bind error if it was revoked.
        if (ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            call.reject("Camera permission is required for patrol mode. Allow it in Android settings.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (panel != null) { call.reject("Patrol already active"); return; }
            boolean vehicle = "vehicle".equals(call.getString("mode"));
            session = UUID.randomUUID().toString();
            String current = session;
            try {
                reader = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION,70);
                initialZoom = call.getDouble("zoom",1.0).floatValue();
                presets.clear();
                JSArray requested = call.getArray("presets");
                if (requested != null) for (int i=0;i<requested.length();i++) presets.add((float)requested.optDouble(i,1));
                if (presets.isEmpty()) presets.addAll(Arrays.asList(1f,1.75f,3.5f,5f));
                panel = new FrameLayout(getContext());
                PreviewView preview = new PreviewView(getContext());
                panel.addView(preview);
                buildPlateGuide();
                Button done = new Button(getContext());
                done.setText("Finish patrol and review");
                done.setOnClickListener(v -> finish());
                LinearLayout controls = buildZoomControls();
                controls.addView(done,new LinearLayout.LayoutParams(-1,-2));
                panel.addView(controls,new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM));
                // Rotation keeps this activity (configChanges), so re-fit the guide and the focus region.
                panel.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob) -> {
                    if (r-l!=or-ol || b-t!=ob-ot) { fitGuide(r-l,b-t); applyPlateFocus(); }
                });
                getActivity().addContentView(panel,new ViewGroup.LayoutParams(-1,-1));
                var future = ProcessCameraProvider.getInstance(getContext());
                var main = ContextCompat.getMainExecutor(getContext());
                future.addListener(() -> {
                    if (!current.equals(session)) {call.reject("Patrol ended");return;}
                    try {
                        provider = future.get();
                        Preview feed = new Preview.Builder().build();
                        feed.setSurfaceProvider(preview.getSurfaceProvider());
                        ImageAnalysis analysis = new ImageAnalysis.Builder().setTargetResolution(new Size(1920,1080))
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                        analysis.setAnalyzer(main,frame -> analyze(frame,current,vehicle));
                        camera = provider.bindToLifecycle(getActivity(),CameraSelector.DEFAULT_BACK_CAMERA,feed,analysis);
                        zoomReady = false;
                        camera.getCameraInfo().getZoomState().observe(getActivity(),this::onZoomState);
                        applyPlateFocus();
                        call.resolve();
                    } catch(Exception e) {finish();call.reject("Camera unavailable",e);}
                },main);
            } catch(Exception e) {finish();call.reject("Patrol failed",e);}
        });
    }

    @androidx.camera.core.ExperimentalGetImage
    private void analyze(ImageProxy frame,String current,boolean vehicle) {
        if (!current.equals(session) || frame.getImage()==null) {frame.close();return;}
        int rotation = frame.getImageInfo().getRotationDegrees();
        long at = System.currentTimeMillis();
        InputImage image = InputImage.fromMediaImage(frame.getImage(),rotation);
        reader.process(image).addOnSuccessListener(result -> {
            if (!current.equals(session)) return;
            Set<String> seen = new HashSet<>();
            for (Text.TextBlock block:result.getTextBlocks()) for (Text.Line line:block.getLines()) {
                Rect box = line.getBoundingBox();
                String plate = line.getText().toUpperCase(Locale.ROOT).replaceAll("[ -]","");
                if (box==null || !plate.matches("[A-Z0-9]{2,8}") || box.width()<1.4*box.height()) continue;
                if (!seen.add(plate)) continue;
                long now = SystemClock.elapsedRealtime();
                Long previous = lastSeen.put(plate,now);
                if (previous==null || now-previous>(vehicle?900:1500)) {emitted.remove(plate);continue;}
                if (emitted.contains(plate)) continue;
                try {
                    Bitmap raw = frame.toBitmap();
                    Matrix m = new Matrix(); m.postRotate(rotation);
                    Bitmap upright = Bitmap.createBitmap(raw,0,0,raw.getWidth(),raw.getHeight(),m,true);
                    File path = File.createTempFile("patrol-", ".jpg",getContext().getCacheDir());
                    try(FileOutputStream out = new FileOutputStream(path)) {upright.compress(Bitmap.CompressFormat.JPEG,88,out);}
                    JSObject event = new JSObject();
                    event.put("plate",plate); event.put("at",at); event.put("path",path.getAbsolutePath());
                    event.put("x",box.left);event.put("y",box.top);event.put("width",box.width());event.put("height",box.height());
                    emitted.add(plate);
                    notifyListeners("sighting",event);
                } catch(Exception error) {finish();break;}
            }
        }).addOnCompleteListener(task -> frame.close());
    }

    /* ───────────── Plate guide and focus ───────────── */

    private float dp(float v) { return v*getContext().getResources().getDisplayMetrics().density; }

    private void buildPlateGuide() {
        guide = new View(getContext());
        GradientDrawable border = new GradientDrawable();
        border.setStroke((int)dp(3),Color.parseColor("#4FD1C5"));
        border.setCornerRadius(dp(12));
        guide.setBackground(border);
        guide.setContentDescription("Plate capture area");
        var metrics = getContext().getResources().getDisplayMetrics();
        panel.addView(guide,new FrameLayout.LayoutParams(0,0,Gravity.CENTER));
        fitGuide(metrics.widthPixels,metrics.heightPixels);
    }

    /** Same 3:1 box as the scan screen: 82% of the width, at most 576 dp wide. */
    private void fitGuide(int width,int height) {
        if (guide==null || width<=0 || height<=0) return;
        int w = (int)Math.min(width*0.82f,dp(576));
        FrameLayout.LayoutParams p = (FrameLayout.LayoutParams)guide.getLayoutParams();
        p.width = w; p.height = w/3;
        guide.setLayoutParams(p);
    }

    /**
     * Keep continuous autofocus and auto-exposure, but only measure inside the plate guide,
     * so the lens tracks the plate as distance changes instead of hunting onto passing
     * objects or the background. A fixed focus lock would blur as soon as the officer moved.
     */
    @OptIn(markerClass=ExperimentalCamera2Interop.class)
    private void applyPlateFocus() {
        if (camera==null || panel==null || guide==null) return;
        try {
            Camera2CameraInfo info = Camera2CameraInfo.from(camera.getCameraInfo());
            Rect active = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            if (active==null || panel.getWidth()==0 || panel.getHeight()==0) return;
            float fw = Math.min(1f,guide.getLayoutParams().width/(float)panel.getWidth());
            float fh = Math.min(1f,guide.getLayoutParams().height/(float)panel.getHeight());
            int displayRotation = panel.getDisplay()!=null ? panel.getDisplay().getRotation() : Surface.ROTATION_0;
            int sensor = camera.getCameraInfo().getSensorRotationDegrees(displayRotation);
            // The sensor is landscape: when the screen is rotated against it, screen width runs along sensor height.
            float sx = sensor%180==0 ? fw : fh, sy = sensor%180==0 ? fh : fw;
            int rw = (int)(active.width()*sx), rh = (int)(active.height()*sy);
            MeteringRectangle region = new MeteringRectangle((active.width()-rw)/2,(active.height()-rh)/2,rw,rh,MeteringRectangle.METERING_WEIGHT_MAX);
            CaptureRequestOptions.Builder options = new CaptureRequestOptions.Builder();
            int[] afModes = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
            if (afModes!=null) for (int mode:afModes) if (mode==CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                options.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            Integer maxAf = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
            Integer maxAe = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
            if (maxAf!=null && maxAf>0) options.setCaptureRequestOption(CaptureRequest.CONTROL_AF_REGIONS,new MeteringRectangle[]{region});
            if (maxAe!=null && maxAe>0) options.setCaptureRequestOption(CaptureRequest.CONTROL_AE_REGIONS,new MeteringRectangle[]{region});
            Camera2CameraControl.from(camera.getCameraControl()).setCaptureRequestOptions(options.build());
        } catch (Exception ignored) {
            // Focus regions are an improvement only; the camera keeps CameraX's default focus.
        }
    }

    /* ───────────── Zoom ───────────── */

    private LinearLayout buildZoomControls() {
        LinearLayout controls = new LinearLayout(getContext());
        controls.setOrientation(LinearLayout.VERTICAL);
        controls.setBackgroundColor(0x99000000);
        int pad = (int)dp(8);
        controls.setPadding(pad,pad,pad,0);

        sliderRow = new LinearLayout(getContext());
        sliderRow.setGravity(Gravity.CENTER_VERTICAL);
        sliderRow.setVisibility(View.GONE);
        zoomLabel = new TextView(getContext());
        zoomLabel.setTextColor(Color.WHITE);
        zoomLabel.setMinWidth((int)dp(56));
        slider = new SeekBar(getContext());
        slider.setMax(SLIDER_STEPS);
        slider.setContentDescription("Zoom");
        slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s,int p,boolean fromUser) { if (fromUser) setZoom(progressToZoom(p),false); }
            @Override public void onStartTrackingTouch(SeekBar s) {}
            @Override public void onStopTrackingTouch(SeekBar s) { setZoom(progressToZoom(s.getProgress()),true); }
        });
        sliderRow.addView(zoomLabel,new LinearLayout.LayoutParams(-2,-2));
        sliderRow.addView(slider,new LinearLayout.LayoutParams(0,-2,1f));
        controls.addView(sliderRow,new LinearLayout.LayoutParams(-1,(int)dp(48)));

        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER);
        presetButtons.clear();
        for (float z:presets) {
            Button b = new Button(getContext());
            b.setAllCaps(false);
            b.setText(formatZoom(z));
            b.setContentDescription("Zoom "+formatZoom(z)+". Long-press for a custom zoom.");
            b.setVisibility(View.GONE); // shown once the lens range is known
            b.setOnClickListener(v -> { sliderRow.setVisibility(View.GONE); setZoom(z,true); });
            b.setOnLongClickListener(v -> {
                sliderRow.setVisibility(sliderRow.getVisibility()==View.VISIBLE ? View.GONE : View.VISIBLE);
                return true; // consumes the press so the preset is not also chosen
            });
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-2,-2);
            p.setMargins((int)dp(4),0,(int)dp(4),0);
            row.addView(b,p);
            presetButtons.add(b);
        }
        controls.addView(row,new LinearLayout.LayoutParams(-1,-2));
        return controls;
    }

    private void onZoomState(ZoomState state) {
        if (state==null || panel==null) return;
        zoomMin = state.getMinZoomRatio();
        zoomMax = Math.max(zoomMin,Math.min(state.getMaxZoomRatio(),MAX_ZOOM));
        for (int i=0;i<presetButtons.size();i++) {
            float z = presets.get(i);
            presetButtons.get(i).setVisibility(z>=zoomMin-1e-3f && z<=zoomMax+1e-3f ? View.VISIBLE : View.GONE);
        }
        if (!zoomReady) { zoomReady = true; setZoom(initialZoom,false); return; }
        showZoom(state.getZoomRatio());
    }

    private float progressToZoom(int progress) { return zoomMin+(zoomMax-zoomMin)*progress/(float)SLIDER_STEPS; }

    private void setZoom(float requested,boolean persist) {
        if (camera==null) return;
        float z = Float.isNaN(requested) ? zoomMin : Math.max(zoomMin,Math.min(zoomMax,requested));
        camera.getCameraControl().setZoomRatio(z);
        showZoom(z);
        if (persist) {
            JSObject event = new JSObject();
            event.put("ratio",(double)z);
            notifyListeners("zoom",event);
        }
    }

    private void showZoom(float z) {
        if (zoomLabel==null) return;
        zoomLabel.setText(formatZoom(z));
        if (!slider.isPressed() && zoomMax>zoomMin) slider.setProgress(Math.round((z-zoomMin)/(zoomMax-zoomMin)*SLIDER_STEPS));
        for (int i=0;i<presetButtons.size();i++) {
            boolean selected = Math.abs(presets.get(i)-z)<0.01f;
            presetButtons.get(i).setSelected(selected);
            presetButtons.get(i).setAlpha(selected ? 1f : 0.7f);
        }
    }

    private static String formatZoom(float z) {
        String s = String.format(Locale.ROOT,"%.2f",z).replaceAll("0+$","").replaceAll("\\.$","");
        return s+"×";
    }

    @PluginMethod public void alert(PluginCall call) {
        if(tone!=null) tone.startTone(ToneGenerator.TONE_PROP_BEEP,180);
        call.resolve();
    }
    @PluginMethod public void stop(PluginCall call) {getActivity().runOnUiThread(() -> {finish();call.resolve();});}
    @PluginMethod public void release(PluginCall call) {
        String path = call.getString("path","");
        File f = new File(path);
        if (getContext().getCacheDir().equals(f.getParentFile()) && f.getName().startsWith("patrol-")) f.delete();
        call.resolve();
    }
    private void finish() {
        if(panel==null)return;
        session=null;
        if(camera!=null)camera.getCameraInfo().getZoomState().removeObservers(getActivity());
        if(provider!=null)provider.unbindAll();
        camera=null;guide=null;sliderRow=null;slider=null;zoomLabel=null;presetButtons.clear();
        if(reader!=null)reader.close();
        if(tone!=null){tone.release();tone=null;}
        ((ViewGroup)panel.getParent()).removeView(panel);
        panel=null;lastSeen.clear();emitted.clear();
        notifyListeners("finished",new JSObject());
    }
    @Override protected void handleOnDestroy(){finish();}
}
