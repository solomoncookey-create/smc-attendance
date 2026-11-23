const db = window.supabase.createClient(
  window.SUPABASE_URL,
  window.SUPABASE_PUBLISHABLE_KEY
);

const $ = (id) => document.getElementById(id);

const OFFICE = {
  lat: 9.027469,
  lng: 7.500262,
  radiusMeters: 100
};

const FACE_THRESHOLD = 0.52;

let currentProfile = null;
let cameraStream = null;
let signupDescriptor = null;
let checkinPosition = null;
let faceModelReady = null;

const faceModel = new window.Human.Human({
  modelBasePath: "https://cdn.jsdelivr.net/npm/@vladmandic/human/models",
  face: {
    enabled: true,
    detector: { enabled: true },
    description: { enabled: true },
    iris: { enabled: false },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false }
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false }
});

function showMessage(id, text, isError = false) {
  const box = $(id);
  if (!box) return;

  box.textContent = text;
  box.classList.remove("hidden", "error");
  if (isError) box.classList.add("error");
}

function clearMessage(id) {
  $(id)?.classList.add("hidden");
}

function showView(id) {
  ["welcomeView", "authView", "staffView", "adminView"].forEach((view) => {
    $(view)?.classList.add("hidden");
  });
  $(id)?.classList.remove("hidden");
}

function setAuthMode(mode) {
  const isSignup = mode === "signup";
  showView("authView");
  $("signInForm").classList.toggle("hidden", isSignup);
  $("signUpForm").classList.toggle("hidden", !isSignup);
  clearMessage("authMessage");
}

function setStaffPage(id) {
  ["attendancePage", "evaluationPage"].forEach((page) => {
    $(page).classList.toggle("hidden", page !== id);
  });
}

function setAdminPage(id) {
  ["adminAttendancePage", "adminEvaluationPage"].forEach((page) => {
    $(page).classList.toggle("hidden", page !== id);
  });
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function startOfMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(year, monthNumber - 1, 1);
}

function startOfWeek(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function startOfDay(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  return new Date(value).toLocaleDateString();
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function distanceInMeters(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) *
    Math.cos(radians(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser does not provide location access."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy
      }),
      (error) => {
        reject(new Error(
          error.code === 1
            ? "Allow location access in your browser, then try again."
            : "Could not get your location. Check GPS and try again."
        ));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

async function loadFaceModel() {
  if (!window.Human?.Human) {
    throw new Error("The free face model did not load. Check your internet connection and refresh.");
  }

  if (!faceModelReady) {
    faceModelReady = (async () => {
      await faceModel.load();
      await faceModel.warmup();
    })();
  }

  await faceModelReady;
}

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
}

async function openCamera(videoId, captureButtonId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access needs localhost or a secure HTTPS page.");
  }

  await loadFaceModel();
  stopCamera();

  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false
  });

  const video = $(videoId);
  video.srcObject = cameraStream;
  video.classList.remove("hidden");
  await video.play();

  $(captureButtonId).disabled = false;
}

async function captureFace(videoId) {
  await loadFaceModel();

  const result = await faceModel.detect($(videoId));
  const faces = (result.face || []).filter((face) => face.embedding?.length);

  if (faces.length !== 1) {
    throw new Error("Keep one face in view, with good lighting, and try again.");
  }

  return Array.from(faces[0].embedding);
}

async function saveFaceTemplate(userId, embedding) {
  const { error } = await db
    .from("face_templates")
    .upsert(
      { user_id: userId, embedding },
      { onConflict: "user_id" }
    );

  if (error) throw error;
}

async function signUp(event) {
  event.preventDefault();
  clearMessage("authMessage");

  if (!signupDescriptor) {
    showMessage("authMessage", "Open the camera and capture your face before creating the account.", true);
    return;
  }

  if (!$("faceConsent").checked) {
    showMessage("authMessage", "Please agree to use the face template for this prototype.", true);
    return;
  }

  const button = $("createAccountButton");
  button.disabled = true;
  button.textContent = "Creating account...";

  const { data, error } = await db.auth.signUp({
    email: $("signupEmail").value.trim(),
    password: $("signupPassword").value,
    options: {
      data: {
        full_name: $("signupName").value.trim(),
        staff_type: $("staffType").value,
        off_day: $("offDay").value
      }
    }
  });

  button.disabled = false;
  button.textContent = "Create account";

  if (error) {
    showMessage("authMessage", error.message, true);
    return;
  }

  if (!data.user) {
    showMessage("authMessage", "Account was not returned. Please try again.", true);
    return;
  }

  sessionStorage.setItem("smcPendingFace", JSON.stringify(signupDescriptor));

  if (data.session) {
    try {
      await saveFaceTemplate(data.user.id, signupDescriptor);
      sessionStorage.removeItem("smcPendingFace");
      signupDescriptor = null;
      stopCamera();
      await openAccount(data.user);
    } catch (saveError) {
      showMessage("authMessage", `Account created, but face enrollment did not save: ${saveError.message}`, true);
    }
  } else {
    showMessage(
      "authMessage",
      "Account created. Confirm your email if asked, then sign in on this browser to finish saving the face template. No admin approval is required."
    );
  }
}

async function signIn(event) {
  event.preventDefault();
  clearMessage("authMessage");

  const identifier = $("loginIdentifier").value.trim();
  const password = $("loginPassword").value;

  if (!identifier || !password) {
    showMessage("authMessage", "Enter your email or full name and password.", true);
    return;
  }

  const button = $("signInButton");
  button.disabled = true;
  button.textContent = "Signing in...";

  let user = null;
  let error = null;

  if (identifier.includes("@")) {
    const result = await db.auth.signInWithPassword({
      email: identifier,
      password
    });

    user = result.data.user;
    error = result.error;
  } else {
    const result = await db.functions.invoke("name-sign-in", {
      body: { name: identifier, password }
    });

    if (result.error) {
      error = result.error;
    } else if (result.data?.access_token && result.data?.refresh_token) {
      const sessionResult = await db.auth.setSession({
        access_token: result.data.access_token,
        refresh_token: result.data.refresh_token
      });

      user = sessionResult.data.session?.user;
      error = sessionResult.error;
    } else {
      error = new Error("Name sign-in is not connected yet. Use your email for now.");
    }
  }

  button.disabled = false;
  button.textContent = "Sign in";

  if (error || !user) {
    showMessage("authMessage", error?.message || "Sign-in failed. Check your details.", true);
    return;
  }

  const pendingFace = sessionStorage.getItem("smcPendingFace");

  if (pendingFace) {
    try {
      await saveFaceTemplate(user.id, JSON.parse(pendingFace));
      sessionStorage.removeItem("smcPendingFace");
    } catch (saveError) {
      showMessage("authMessage", `Signed in, but face enrollment did not save: ${saveError.message}`, true);
      return;
    }
  }

  await openAccount(user);
}

async function openAccount(user) {
  const { data: profile, error } = await db
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !profile) {
    showMessage("authMessage", "Your profile could not be loaded. The Supabase setup step is still needed.", true);
    return;
  }

  currentProfile = profile;
  stopCamera();

  if (profile.is_admin) {
    showView("adminView");
    $("adminMonth").value = currentMonth();
    $("ratingMonth").value = currentMonth();
    await renderAdmin();
  } else {
    showView("staffView");
    setStaffPage("attendancePage");
    await renderStaff();
  }
}

async function renderStaff() {
  if (!currentProfile) return;

  const { data, error } = await db
    .from("attendance_records")
    .select("id, attended_at, location_verified, face_verified")
    .eq("user_id", currentProfile.id)
    .order("attended_at", { ascending: false });

  if (error) {
    showMessage("attendanceMessage", error.message, true);
    return;
  }

  const records = data || [];
  const now = new Date();

  $("staffName").textContent =
    currentProfile.full_name || currentProfile.email || "Staff";
  $("staffOffDay").textContent = currentProfile.off_day || "—";
  $("staffWeekCount").textContent =
    records.filter((record) => new Date(record.attended_at) >= startOfWeek(now)).length;
  $("staffMonthCount").textContent =
    records.filter((record) =>
      new Date(record.attended_at) >= new Date(now.getFullYear(), now.getMonth(), 1)
    ).length;

  $("todayDate").textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const weekBeginning = startOfWeek(now);

  $("weekList").innerHTML = weekdays.map((day, index) => {
    const date = new Date(weekBeginning);
    date.setDate(weekBeginning.getDate() + index);

    const record = records.find(
      (item) => new Date(item.attended_at).toDateString() === date.toDateString()
    );

    const isOffDay = day === currentProfile.off_day;
    const status = isOffDay
      ? "OFF"
      : record
        ? `Present · ${formatTime(record.attended_at)}`
        : "—";

    return `
      <div class="day-row ${isOffDay ? "off" : ""}">
        <span>${day}${isOffDay ? " · Off day" : ""}</span>
        <em>${status}</em>
      </div>
    `;
  }).join("");

  await renderStaffEvaluation();
}

async function renderStaffEvaluation() {
  const month = $("staffEvaluationMonth").value || currentMonth();
  $("staffEvaluationMonth").value = month;

  const start = startOfMonth(month);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);

  const { count, error } = await db
    .from("attendance_records")
    .select("id", { count: "exact", head: true })
    .eq("user_id", currentProfile.id)
    .gte("attended_at", start.toISOString())
    .lt("attended_at", end.toISOString());

  if (error) {
    showMessage("staffEvaluationSummary", error.message, true);
    return;
  }

  const monthName = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric"
  });

  $("staffEvaluationSummary").textContent =
    `${monthName}: ${count || 0} attendance day(s). Your off day is excluded from attendance expectations.`;

  const { data: evaluation } = await db
    .from("monthly_evaluations")
    .select("rating, comment")
    .eq("user_id", currentProfile.id)
    .eq("evaluation_month", `${month}-01`)
    .maybeSingle();

  $("staffRatingDisplay").textContent = evaluation
    ? `Admin rating: ${evaluation.rating}/5${evaluation.comment ? ` · ${evaluation.comment}` : ""}`
    : "No admin rating recorded for this month yet.";
}

async function checkLocation() {
  try {
    clearMessage("attendanceMessage");

    const position = await getLocation();
    const distance = distanceInMeters(
      position.latitude,
      position.longitude,
      OFFICE.lat,
      OFFICE.lng
    );

    if (position.accuracy > 100) {
      showMessage("attendanceMessage", "GPS accuracy is too low. Move to an open area and try again.", true);
      return;
    }

    if (distance > OFFICE.radiusMeters) {
      showMessage(
        "attendanceMessage",
        `Outside the NSPM site area (${Math.round(distance)} m from the map pin).`,
        true
      );
      return;
    }

    checkinPosition = position;
    showMessage("attendanceMessage", "Location is within the NSPM site area. Starting the face check.");

    await openCamera("checkinVideo", "captureCheckinFace");
    $("checkinFaceBox").classList.remove("hidden");
  } catch (error) {
    showMessage("attendanceMessage", error.message, true);
  }
}

async function verifyFaceAndCheckIn() {
  const button = $("captureCheckinFace");
  button.disabled = true;
  button.textContent = "Checking face...";

  try {
    if (!checkinPosition) {
      throw new Error("Check your location first.");
    }

    const descriptor = await captureFace("checkinVideo");

    const { data: saved, error } = await db
      .from("face_templates")
      .select("embedding")
      .eq("user_id", currentProfile.id)
      .maybeSingle();

    if (error) throw error;
    if (!saved?.embedding?.length) {
      throw new Error("No face template is saved for this account.");
    }

    const match = faceModel.match.find(
      descriptor,
      [saved.embedding],
      { order: 2, multiplier: 25, min: 0.2, max: 0.8 }
    );

    if (!match || match.similarity < FACE_THRESHOLD) {
      throw new Error("Face did not match the signup template. Try better lighting.");
    }

    const today = startOfDay();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const { data: existing, error: lookupError } = await db
      .from("attendance_records")
      .select("id")
      .eq("user_id", currentProfile.id)
      .gte("attended_at", today.toISOString())
      .lt("attended_at", tomorrow.toISOString())
      .limit(1);

    if (lookupError) throw lookupError;
    if (existing?.length) throw new Error("Today’s attendance is already recorded.");

    const { error: insertError } = await db
      .from("attendance_records")
      .insert({
        user_id: currentProfile.id,
        attended_at: new Date().toISOString(),
        location_verified: true,
        face_verified: true
      });

    if (insertError) throw insertError;

    showMessage("attendanceMessage", "Attendance recorded. Face matched and GPS is within the site area.");
    $("checkinFaceBox").classList.add("hidden");
    stopCamera();
    checkinPosition = null;
    await renderStaff();
  } catch (error) {
    showMessage("attendanceMessage", error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Verify face and check in";
  }
}

async function renderAdmin() {
  const { data: people, error } = await db
    .from("profiles")
    .select("id, email, full_name, staff_type, off_day, is_admin")
    .order("full_name");

  if (error) {
    showMessage("authMessage", error.message, true);
    return;
  }

  const staff = (people || []).filter((person) => !person.is_admin);

  $("adminStaffTotal").textContent = staff.length;
  $("ratingStaff").innerHTML =
    '<option value="">Choose staff</option>' +
    staff.map((person) =>
      `<option value="${person.id}">${safeText(person.full_name || person.email)} · ${safeText(person.staff_type || "")}</option>`
    ).join("");

  await renderAdminAttendance();
  await renderAdminEvaluations();
}

async function renderAdminAttendance() {
  const { data: profiles, error: profileError } = await db
    .from("profiles")
    .select("id, email, full_name, staff_type");

  if (profileError) return;

  const { data: records, error } = await db
    .from("attendance_records")
    .select("id, user_id, attended_at, location_verified, face_verified")
    .order("attended_at", { ascending: false })
    .limit(300);

  if (error) {
    showMessage("authMessage", error.message, true);
    return;
  }

  const month = $("adminMonth").value || currentMonth();
  const start = startOfMonth(month);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  const filtered = (records || []).filter((record) => {
    const date = new Date(record.attended_at);
    return date >= start && date < end;
  });

  const now = new Date();
  $("adminWeekTotal").textContent =
    (records || []).filter((record) => new Date(record.attended_at) >= startOfWeek(now)).length;
  $("adminTodayTotal").textContent =
    (records || []).filter((record) =>
      new Date(record.attended_at).toDateString() === now.toDateString()
    ).length;

  $("adminAttendanceRows").innerHTML = filtered.map((record) => {
    const person = profiles.find((item) => item.id === record.user_id);

    return `
      <tr>
        <td>${safeText(person?.full_name || person?.email || "Staff")}</td>
        <td>${safeText(person?.staff_type || "—")}</td>
        <td>${safeText(formatDate(record.attended_at))}</td>
        <td>${safeText(formatTime(record.attended_at))}</td>
        <td>${record.location_verified ? "GPS" : "—"} · ${record.face_verified ? "Face" : "—"}</td>
      </tr>
    `;
  }).join("") || '<tr><td colspan="5">No check-ins for this month.</td></tr>';
}

async function saveEvaluation() {
  const month = $("ratingMonth").value;
  const userId = $("ratingStaff").value;
  const rating = Number($("ratingValue").value);
  const comment = $("ratingComment").value.trim();

  if (!month || !userId || !rating) {
    alert("Choose a month, staff member, and rating.");
    return;
  }

  const { error } = await db
    .from("monthly_evaluations")
    .upsert({
      user_id: userId,
      evaluation_month: `${month}-01`,
      rating,
      comment,
      admin_id: currentProfile.id
    }, {
      onConflict: "user_id,evaluation_month"
    });

  if (error) {
    alert(error.message);
    return;
  }

  $("ratingComment").value = "";
  await renderAdminEvaluations();
  alert("Monthly evaluation saved.");
}

async function renderAdminEvaluations() {
  const month = $("ratingMonth").value || currentMonth();
  $("ratingMonth").value = month;

  const { data: evaluations, error } = await db
    .from("monthly_evaluations")
    .select("user_id, evaluation_month, rating, comment")
    .eq("evaluation_month", `${month}-01`)
    .order("rating", { ascending: false });

  if (error) return;

  const { data: profiles } = await db
    .from("profiles")
    .select("id, full_name, email, staff_type");

  $("adminEvaluationRows").innerHTML = (evaluations || []).map((item) => {
    const person = profiles?.find((profile) => profile.id === item.user_id);

    return `
      <div class="evaluation-card">
        <strong>${safeText(person?.full_name || person?.email || "Staff member")}</strong>
        <div>${item.rating}/5 · ${safeText(person?.staff_type || "")}</div>
        <small>${safeText(item.comment || "No comment")}</small>
      </div>
    `;
  }).join("") || '<p class="tiny-note">No ratings recorded for this month.</p>';
}

async function signOut() {
  stopCamera();
  await db.auth.signOut();
  currentProfile = null;
  showView("welcomeView");
}

document.querySelectorAll("[data-auth-mode]").forEach((button) => {
  button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.page.startsWith("admin")) {
      setAdminPage(button.dataset.page);
    } else {
      setStaffPage(button.dataset.page);
    }
  });
});

$("signInForm").addEventListener("submit", signIn);
$("signUpForm").addEventListener("submit", signUp);

$("startSignupCamera").addEventListener("click", async () => {
  try {
    await openCamera("signupVideo", "captureSignupFace");
    showMessage("signupFaceStatus", "Camera ready. Center your face and capture it.");
  } catch (error) {
    showMessage("signupFaceStatus", error.message, true);
  }
});

$("captureSignupFace").addEventListener("click", async () => {
  try {
    signupDescriptor = await captureFace("signupVideo");
    sessionStorage.setItem("smcPendingFace", JSON.stringify(signupDescriptor));
    showMessage("signupFaceStatus", "Face template captured. It will be saved when the account is created.");
    stopCamera();
    $("signupVideo").classList.add("hidden");
  } catch (error) {
    showMessage("signupFaceStatus", error.message, true);
  }
});

$("checkLocationButton").addEventListener("click", checkLocation);
$("captureCheckinFace").addEventListener("click", verifyFaceAndCheckIn);
$("staffEvaluationMonth").addEventListener("change", renderStaffEvaluation);
$("adminMonth").addEventListener("change", renderAdminAttendance);
$("ratingMonth").addEventListener("change", renderAdminEvaluations);
$("saveRatingButton").addEventListener("click", saveEvaluation);
$("signOutButton").addEventListener("click", signOut);
$("adminSignOutButton").addEventListener("click", signOut);

(async function restoreSession() {
  $("staffEvaluationMonth").value = currentMonth();
  $("adminMonth").value = currentMonth();
  $("ratingMonth").value = currentMonth();

  const { data } = await db.auth.getSession();

  if (data.session?.user) {
    await openAccount(data.session.user);
  } else {
    showView("welcomeView");
  }
})();