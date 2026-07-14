const fetch = require('node-fetch');

async function testLoginAndFetch() {
  try {
    // 1. Login as Ishakya
    const loginRes = await fetch("http://localhost:5000/api/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ishakyaranhiru@gmail.com", password: "password123" })
    });
    
    if (!loginRes.ok) {
        console.log("Login failed with status:", loginRes.status, await loginRes.text());
        return;
    }
    
    const session = await loginRes.json();
    console.log("Logged in successfully. Token length:", session.accessToken.length);
    
    // 2. Fetch events
    const eventsRes = await fetch("http://localhost:5000/api/events", {
      headers: { "Authorization": "Bearer " + session.accessToken }
    });
    
    if (!eventsRes.ok) {
        console.log("Events fetch failed with status:", eventsRes.status, await eventsRes.text());
        return;
    }
    
    const events = await eventsRes.json();
    console.log("Fetched events count:", events.length);
    if (events.length > 0) {
        console.log("First event:", events[0].event_type);
    }
  } catch (err) {
    console.error("Test failed:", err);
  }
}

testLoginAndFetch();
